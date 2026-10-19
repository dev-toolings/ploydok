// SPDX-License-Identifier: AGPL-3.0-only
// Freestanding Linux executable: no libc, interpreter, shell or image tools.
// Compile with the same native/cross compiler as the agent. This keeps the
// runtime artifact independent of the application's libc and filesystem.
#include <asm/unistd.h>
#include <linux/sockios.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include "http_probe_shell.h"

#if defined(__x86_64__)
static long call(long n, long a, long b, long c, long d, long e) {
    register long r10 __asm__("r10") = d;
    register long r8 __asm__("r8") = e;
    long result;
    __asm__ volatile("syscall" : "=a"(result)
                     : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8)
                     : "rcx", "r11", "memory");
    return result;
}
__asm__(".global _start\n_start:\nmov %rsp,%rdi\nand $-16,%rsp\ncall probe_start\n");
#elif defined(__aarch64__)
static long call(long n, long a, long b, long c, long d, long e) {
    register long x8 __asm__("x8") = n;
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register long x3 __asm__("x3") = d;
    register long x4 __asm__("x4") = e;
    __asm__ volatile("svc 0" : "+r"(x0)
                     : "r"(x8), "r"(x1), "r"(x2), "r"(x3), "r"(x4) : "memory");
    return x0;
}
__asm__(".global _start\n_start:\nmov x0,sp\nbl probe_start\n");
#else
#error Unsupported Linux architecture for the static health probe
#endif

static unsigned long length(const char *s) {
    unsigned long n = 0;
    while (s[n]) n++;
    return n;
}
static int equal(const char *a, const char *b) {
    while (*a && *a == *b) { a++; b++; }
    return *a == *b;
}
static void message(const char *s) {
    call(__NR_write, 2, (long)s, length(s), 0, 0);
}
static void finish(int code) {
    call(__NR_exit_group, code, 0, 0, 0, 0);
    __builtin_unreachable();
}
static int http(unsigned int ip, unsigned short port, const char *request, unsigned long size) {
    long fd = call(__NR_socket, AF_INET, SOCK_STREAM, 0, 0, 0);
    if (fd < 0) return 0;
    struct timeval timeout = { .tv_sec = 1, .tv_usec = 0 };
    call(__NR_setsockopt, fd, SOL_SOCKET, SO_RCVTIMEO, (long)&timeout, sizeof(timeout));
    call(__NR_setsockopt, fd, SOL_SOCKET, SO_SNDTIMEO, (long)&timeout, sizeof(timeout));
    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = port, .sin_addr = { ip } };
    int ok = 0;
    if (call(__NR_connect, fd, (long)&addr, sizeof(addr), 0, 0) == 0) {
        unsigned long sent = 0;
        while (sent < size) {
            long n = call(__NR_write, fd, (long)(request + sent), size - sent, 0, 0);
            if (n <= 0) break;
            sent += n;
        }
        char status[12];
        unsigned long got = 0;
        while (sent == size && got < sizeof(status)) {
            long n = call(__NR_read, fd, (long)(status + got), sizeof(status) - got, 0, 0);
            if (n <= 0) break;
            got += n;
        }
        // A listening TCP port is insufficient: require a real HTTP response.
        ok = got == sizeof(status) && status[0] == 'H' && status[1] == 'T' &&
             status[2] == 'T' && status[3] == 'P' && status[4] == '/' &&
             status[5] == '1' && status[6] == '.' && (status[7] == '0' || status[7] == '1') &&
             status[8] == ' ' && status[9] >= '2' && status[9] <= '4' &&
             status[10] >= '0' && status[10] <= '9' && status[11] >= '0' && status[11] <= '9';
    }
    call(__NR_close, fd, 0, 0, 0, 0);
    return ok;
}

void probe_start(long *stack) {
    long argc = stack[0];
    char **argv = (char **)(stack + 1);
    char **envp = argv + argc + 1;
    if (argc != 4 || (!equal(argv[1], "auto") && !equal(argv[1], "http"))) {
        message("healthcheck impossible: invalid static probe arguments\n");
        finish(1);
    }
    if (equal(argv[1], "auto")) {
        char *shell[] = { "/bin/sh", "-c", probe_shell, "ploydok-healthcheck", argv[2], argv[3], 0 };
        long result = call(__NR_execve, (long)shell[0], (long)shell, (long)envp, 0, 0);
        // ENOENT includes a shell whose dynamic loader is absent.
        if (result != -2) {
            message("healthcheck impossible: /bin/sh exists but cannot execute\n");
            finish(1);
        }
    }
    if (length(argv[2]) > 5) finish(1);
    unsigned long port = 0;
    for (const char *p = argv[2]; *p; p++) {
        if (*p < '0' || *p > '9' || port > 6553) finish(1);
        port = port * 10 + (*p - '0');
    }
    if (!port || port > 65535 || argv[3][0] != '/' || length(argv[3]) > 512) finish(1);
    char request[2048];
    unsigned long size = 0;
    const char *parts[] = { "GET ", argv[3], " HTTP/1.1\r\nHost: 127.0.0.1:", argv[2], "\r\nConnection: close\r\n\r\n" };
    for (int part = 0; part < 5; part++) {
        for (const unsigned char *p = (const unsigned char *)parts[part]; *p; p++) {
            if (part == 1 && (*p <= 0x20 || *p >= 0x7f)) {
                const char *hex = "0123456789ABCDEF";
                request[size++] = '%'; request[size++] = hex[*p >> 4]; request[size++] = hex[*p & 15];
            } else request[size++] = *p;
        }
    }
    unsigned short network_port = (unsigned short)((port >> 8) | (port << 8));
    if (http(0x0100007f, network_port, request, size)) finish(0);
    // Mirror the existing hostname fallback for apps bound to their interface
    // address rather than loopback. SIOCGIFCONF returns local IPv4 addresses.
    long fd = call(__NR_socket, AF_INET, SOCK_STREAM, 0, 0, 0);
    struct ifreq interfaces[32];
    struct ifconf config = { .ifc_len = sizeof(interfaces), .ifc_req = interfaces };
    if (fd >= 0 && call(__NR_ioctl, fd, SIOCGIFCONF, (long)&config, 0, 0) == 0) {
        int count = config.ifc_len / sizeof(struct ifreq);
        for (int i = 0; i < count; i++) {
            struct sockaddr_in *addr = (struct sockaddr_in *)&interfaces[i].ifr_addr;
            if (addr->sin_family == AF_INET && addr->sin_addr.s_addr != 0x0100007f &&
                http(addr->sin_addr.s_addr, network_port, request, size)) finish(0);
        }
    }
    if (fd >= 0) call(__NR_close, fd, 0, 0, 0, 0);
    message("healthcheck failed: image has no executable /bin/sh; native HTTP probe received no 2xx-4xx response on port ");
    message(argv[2]);
    message(" path ");
    message(argv[3]);
    message(" (connection refused, timeout, invalid HTTP or 5xx)\n");
    finish(1);
}
