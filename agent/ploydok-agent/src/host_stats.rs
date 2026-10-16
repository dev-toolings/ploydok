// SPDX-License-Identifier: AGPL-3.0-only
//
// Host VPS monitoring (Sprint 6.6).
// Reads /proc/{stat,meminfo,loadavg,uptime} and runs statvfs on the configured
// host-data mount (falling back to / for development compatibility).
// Aucun new dep lourd : libc::statvfs + lectures fichiers.

use ploydok_proto::HostStatsResponse;
use std::ffi::CString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::{interval, timeout, Instant, MissedTickBehavior};

type CpuJiffies = (u64, u64);
type GpuStats = (u32, f64, u64, u64, String);

/// One host sampler shared by every RPC service instance.
pub struct HostSampler {
    cpu_count: u32,
    mem_configured_bytes: AtomicU64,
    latest: watch::Sender<Option<HostStatsResponse>>,
    gpu: watch::Sender<GpuStats>,
}

impl HostSampler {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cpu_count: num_cpus_from_proc().unwrap_or(0),
            mem_configured_bytes: AtomicU64::new(read_configured_memory(Path::new(
                "/sys/devices/system/memory",
            ))),
            latest: watch::channel(None).0,
            gpu: watch::channel(GpuStats::default()).0,
        })
    }

    /// Start once at agent startup. GPU work never delays the host sampling loop.
    pub fn spawn_poll_task(self: Arc<Self>) {
        let gpu_sampler = Arc::clone(&self);
        tokio::spawn(async move {
            let mut gpu = GpuSampler::new(std::env::var_os("PATH").unwrap_or_default());
            let mut ticks = interval(Duration::from_secs(20));
            ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                gpu_sampler.gpu.send_replace(gpu.refresh().await);
            }
        });
        tokio::spawn(async move {
            let mut previous = None;
            let mut next_memory_probe = Instant::now() + Duration::from_secs(300);
            let mut ticks = interval(Duration::from_secs(2));
            ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                let cpu_count = self.cpu_count;
                let configured = self.mem_configured_bytes.load(Ordering::Relaxed);
                let refresh_memory = Instant::now() >= next_memory_probe;
                match tokio::task::spawn_blocking(move || {
                    let configured = if refresh_memory {
                        read_configured_memory(Path::new("/sys/devices/system/memory"))
                    } else {
                        configured
                    };
                    let (mut snapshot, current) = read_host_stats(cpu_count, previous);
                    snapshot.mem_configured_bytes = configured;
                    (snapshot, current)
                })
                .await
                {
                    Ok((mut snapshot, current)) => {
                        if refresh_memory {
                            self.mem_configured_bytes
                                .store(snapshot.mem_configured_bytes, Ordering::Relaxed);
                            next_memory_probe = Instant::now() + Duration::from_secs(300);
                        }
                        previous = current;
                        merge_gpu(&mut snapshot, self.gpu.borrow().clone());
                        self.latest.send_replace(Some(snapshot));
                    }
                    Err(error) => tracing::warn!(%error, "host sampler failed"),
                }
            }
        });
    }

    pub async fn snapshot(&self) -> HostStatsResponse {
        if let Some(snapshot) = self.latest.borrow().clone() {
            return snapshot;
        }
        // Startup only: do not wait for a CPU interval or a GPU subprocess.
        let cpu_count = self.cpu_count;
        let mut snapshot =
            match tokio::task::spawn_blocking(move || read_host_stats(cpu_count, None)).await {
                Ok((snapshot, _)) => snapshot,
                Err(error) => HostStatsResponse {
                    cpu_count,
                    error: format!("host:{error}"),
                    ..Default::default()
                },
            };
        snapshot.mem_configured_bytes = self.mem_configured_bytes.load(Ordering::Relaxed);
        merge_gpu(&mut snapshot, self.gpu.borrow().clone());
        snapshot
    }
}

/// Best-effort host read. The first observation seeds the CPU delta.
fn read_host_stats(
    cpu_count: u32,
    previous: Option<CpuJiffies>,
) -> (HostStatsResponse, Option<CpuJiffies>) {
    let mut errs: Vec<String> = Vec::new();
    let current = read_cpu_jiffies()
        .map_err(|e| errs.push(format!("cpu:{e}")))
        .ok();
    let cpu_percent = previous.zip(current).map_or(0.0, |(previous, current)| {
        cpu_delta_percent(previous, current)
    });

    let (mem_total, mem_avail, swap_total, swap_used) = match read_meminfo() {
        Ok(v) => v,
        Err(e) => {
            errs.push(format!("mem:{e}"));
            (0, 0, 0, 0)
        }
    };
    let mem_used = mem_total.saturating_sub(mem_avail);

    let (load_1, load_5, load_15) = read_loadavg().unwrap_or_else(|e| {
        errs.push(format!("load:{e}"));
        (0.0, 0.0, 0.0)
    });

    let disk_path = std::env::var("PLOYDOK_HOST_STATS_PATH").unwrap_or_else(|_| "/".to_string());
    let (disk_total, disk_free, disk_used, inodes_total, inodes_used) =
        match statvfs_path(&disk_path) {
            Ok(v) => v,
            Err(e) => {
                errs.push(format!("disk:{e}"));
                (0, 0, 0, 0, 0)
            }
        };

    let uptime_seconds = read_uptime().unwrap_or(0);

    let snapshot = HostStatsResponse {
        cpu_percent,
        mem_total_bytes: mem_total,
        mem_used_bytes: mem_used,
        mem_available_bytes: mem_avail,
        swap_total_bytes: swap_total,
        swap_used_bytes: swap_used,
        load_1,
        load_5,
        load_15,
        disk_total_bytes: disk_total,
        disk_used_bytes: disk_used,
        disk_free_bytes: disk_free,
        inodes_total,
        inodes_used,
        cpu_count,
        uptime_seconds,
        error: errs.join(";"),
        ..Default::default()
    };
    (snapshot, current)
}

// ────────────────────────────────────────────────────────────────────────────
// CPU sampling (/proc/stat delta)
// ────────────────────────────────────────────────────────────────────────────

fn cpu_delta_percent(previous: CpuJiffies, current: CpuJiffies) -> f64 {
    let idle = current.0.saturating_sub(previous.0);
    let total = current.1.saturating_sub(previous.1);
    if total == 0 {
        return 0.0;
    }
    (total.saturating_sub(idle) as f64 / total as f64) * 100.0
}

fn read_cpu_jiffies() -> Result<(u64, u64), String> {
    let s = fs::read_to_string("/proc/stat").map_err(|e| e.to_string())?;
    let line = s
        .lines()
        .next()
        .ok_or_else(|| "empty /proc/stat".to_string())?;
    // Format: "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
    let mut iter = line.split_whitespace();
    iter.next(); // skip "cpu"
    let vals: Vec<u64> = iter.filter_map(|v| v.parse().ok()).collect();
    if vals.len() < 4 {
        return Err("/proc/stat malformed".to_string());
    }
    // Idle includes iowait. Guest time is already included in user/nice.
    let idle = vals[3] + vals.get(4).copied().unwrap_or(0);
    let total: u64 = vals.iter().take(8).sum();
    Ok((idle, total))
}

// ────────────────────────────────────────────────────────────────────────────
// Memory (/proc/meminfo)
// ────────────────────────────────────────────────────────────────────────────

/// Count online memory blocks. Any read/parse failure makes the value unknown.
fn read_configured_memory(root: &Path) -> u64 {
    let read = || -> Option<u64> {
        let block_size = fs::read_to_string(root.join("block_size_bytes")).ok()?;
        let block_size = block_size.trim();
        let block_size =
            u64::from_str_radix(block_size.strip_prefix("0x").unwrap_or(block_size), 16).ok()?;
        let mut online = 0u64;
        for entry in fs::read_dir(root).ok()? {
            let entry = entry.ok()?;
            let name = entry.file_name();
            let Some(index) = name.to_str()?.strip_prefix("memory") else {
                continue;
            };
            if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            let state = fs::read_to_string(entry.path().join("state")).ok()?;
            if state.trim() == "online" {
                online = online.checked_add(1)?;
            }
        }
        block_size.checked_mul(online)
    };
    read().unwrap_or(0)
}

fn read_meminfo() -> Result<(u64, u64, u64, u64), String> {
    let s = fs::read_to_string("/proc/meminfo").map_err(|e| e.to_string())?;
    let mut total = 0u64;
    let mut avail = 0u64;
    let mut swap_total = 0u64;
    let mut swap_free = 0u64;
    for line in s.lines() {
        let (k, v) = match line.split_once(':') {
            Some(p) => p,
            None => continue,
        };
        let kb: u64 = v
            .split_whitespace()
            .next()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        match k {
            "MemTotal" => total = kb * 1024,
            "MemAvailable" => avail = kb * 1024,
            "SwapTotal" => swap_total = kb * 1024,
            "SwapFree" => swap_free = kb * 1024,
            _ => {}
        }
    }
    let swap_used = swap_total.saturating_sub(swap_free);
    Ok((total, avail, swap_total, swap_used))
}

// ────────────────────────────────────────────────────────────────────────────
// Load avg (/proc/loadavg)
// ────────────────────────────────────────────────────────────────────────────

fn read_loadavg() -> Result<(f64, f64, f64), String> {
    let s = fs::read_to_string("/proc/loadavg").map_err(|e| e.to_string())?;
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 3 {
        return Err("malformed".to_string());
    }
    let l1 = parts[0].parse().unwrap_or(0.0);
    let l5 = parts[1].parse().unwrap_or(0.0);
    let l15 = parts[2].parse().unwrap_or(0.0);
    Ok((l1, l5, l15))
}

// ────────────────────────────────────────────────────────────────────────────
// Disk usage / inodes for the host-data bind mount.
// ────────────────────────────────────────────────────────────────────────────

fn statvfs_path(path: &str) -> Result<(u64, u64, u64, u64, u64), String> {
    let path = CString::new(path).map_err(|e| e.to_string())?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::statvfs(path.as_ptr(), &mut stat) };
    if ret != 0 {
        return Err(format!(
            "statvfs failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let block_size = stat.f_frsize as u64;
    let total = stat.f_blocks as u64 * block_size;
    let free = stat.f_bavail as u64 * block_size;
    let used = total.saturating_sub(free);
    let inodes_total = stat.f_files as u64;
    let inodes_used = inodes_total.saturating_sub(stat.f_favail as u64);
    Ok((total, free, used, inodes_total, inodes_used))
}

// ────────────────────────────────────────────────────────────────────────────
// CPU count + uptime
// ────────────────────────────────────────────────────────────────────────────

fn num_cpus_from_proc() -> Result<u32, String> {
    let s = fs::read_to_string("/proc/cpuinfo").map_err(|e| e.to_string())?;
    let n = s.lines().filter(|l| l.starts_with("processor")).count();
    Ok(n as u32)
}

fn read_uptime() -> Result<u64, String> {
    let s = fs::read_to_string("/proc/uptime").map_err(|e| e.to_string())?;
    let first = s.split_whitespace().next().unwrap_or("0");
    let secs: f64 = first.parse().unwrap_or(0.0);
    Ok(secs as u64)
}

// ────────────────────────────────────────────────────────────────────────────
// GPU (host aggregate, via nvidia-smi, best-effort, no GPU is a normal case)
// ────────────────────────────────────────────────────────────────────────────

fn merge_gpu(snapshot: &mut HostStatsResponse, gpu: GpuStats) {
    snapshot.gpu_count = gpu.0;
    snapshot.gpu_utilization_pct = gpu.1;
    snapshot.gpu_mem_used_bytes = gpu.2;
    snapshot.gpu_mem_total_bytes = gpu.3;
    snapshot.gpu_name = gpu.4;
}

fn find_nvidia_smi(search_path: &std::ffi::OsStr) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(search_path)
        .map(|dir| dir.join("nvidia-smi"))
        .find(|path| {
            fs::metadata(path).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
}

struct GpuSampler {
    search_path: std::ffi::OsString,
    executable: Option<PathBuf>,
    next_probe: Instant,
}

impl GpuSampler {
    fn new(search_path: std::ffi::OsString) -> Self {
        Self {
            executable: find_nvidia_smi(&search_path),
            search_path,
            next_probe: Instant::now() + Duration::from_secs(300),
        }
    }

    async fn refresh(&mut self) -> GpuStats {
        if Instant::now() >= self.next_probe {
            self.executable = find_nvidia_smi(&self.search_path);
            self.next_probe = Instant::now() + Duration::from_secs(300);
        }
        match self.executable.as_deref() {
            Some(executable) => read_gpu_stats(executable).await.unwrap_or_default(),
            None => GpuStats::default(),
        }
    }
}

/// A missing, failed or timed-out GPU query yields zeroed fields.
async fn read_gpu_stats(executable: &Path) -> Option<GpuStats> {
    let output = timeout(
        Duration::from_secs(2),
        Command::new(executable)
            .kill_on_drop(true)
            .args([
                "--query-gpu=utilization.gpu,memory.used,memory.total,name",
                "--format=csv,noheader,nounits",
            ])
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut count = 0u32;
    let mut util_sum = 0.0f64;
    let mut mem_used_bytes = 0u64;
    let mut mem_total_bytes = 0u64;
    let mut name = String::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split(',').map(|p| p.trim()).collect();
        if parts.len() < 4 {
            continue;
        }
        let util: f64 = parts[0].parse().unwrap_or(0.0);
        let mem_used_mib: u64 = parts[1].parse().unwrap_or(0);
        let mem_total_mib: u64 = parts[2].parse().unwrap_or(0);
        if count == 0 {
            name = parts[3].to_string();
        }
        util_sum += util;
        mem_used_bytes += mem_used_mib * 1024 * 1024;
        mem_total_bytes += mem_total_mib * 1024 * 1024;
        count += 1;
    }

    if count == 0 {
        return None;
    }

    Some((
        count,
        util_sum / count as f64,
        mem_used_bytes,
        mem_total_bytes,
        name,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_memory_counts_only_online_blocks_and_fails_closed() {
        let directory = tempfile::tempdir().expect("temporary sysfs directory");
        let root = directory.path();
        fs::write(root.join("block_size_bytes"), "8000000\n").expect("block size");
        for index in 0..49 {
            let block = root.join(format!("memory{index}"));
            fs::create_dir(&block).expect("memory block");
            fs::write(
                block.join("state"),
                if index < 48 { "online\n" } else { "offline\n" },
            )
            .expect("block state");
        }
        fs::create_dir(root.join("memory_aux")).expect("unrelated directory");
        assert_eq!(read_configured_memory(root), 6144 * 1024 * 1024);
        fs::write(root.join("block_size_bytes"), "0x8000000\n").expect("prefixed size");
        assert_eq!(read_configured_memory(root), 6144 * 1024 * 1024);
        fs::remove_file(root.join("memory0/state")).expect("remove block state");
        assert_eq!(read_configured_memory(root), 0);
        fs::write(root.join("memory0/state"), "online").expect("restore block state");
        fs::write(root.join("block_size_bytes"), "invalid").expect("malformed size");
        assert_eq!(read_configured_memory(root), 0);
        assert_eq!(read_configured_memory(&root.join("missing")), 0);
    }

    #[test]
    fn cpu_delta_uses_elapsed_jiffies() {
        assert_eq!(cpu_delta_percent((100, 200), (130, 300)), 70.0);
        assert_eq!(cpu_delta_percent((100, 200), (200, 300)), 0.0);
        assert_eq!(cpu_delta_percent((100, 200), (100, 300)), 100.0);
    }

    #[test]
    fn cpu_delta_handles_unchanged_and_reset_counters() {
        assert_eq!(cpu_delta_percent((100, 200), (100, 200)), 0.0);
        assert_eq!(cpu_delta_percent((100, 200), (10, 20)), 0.0);
        assert_eq!(cpu_delta_percent((100, 200), (250, 300)), 0.0);
    }

    #[tokio::test(start_paused = true)]
    async fn missing_gpu_skips_queries_and_reprobes_after_five_minutes() {
        let directory = tempfile::tempdir().expect("temporary PATH directory");
        let mut sampler = GpuSampler::new(directory.path().as_os_str().to_owned());
        assert!(sampler.executable.is_none());
        let next_probe = sampler.next_probe;
        assert_eq!(sampler.refresh().await, GpuStats::default());
        tokio::time::advance(Duration::from_secs(20)).await;
        assert_eq!(sampler.refresh().await, GpuStats::default());
        assert_eq!(sampler.next_probe, next_probe);
        tokio::time::advance(Duration::from_secs(280)).await;
        assert_eq!(sampler.refresh().await, GpuStats::default());
        assert!(sampler.next_probe > next_probe);
        assert!(sampler.executable.is_none());
    }
}
