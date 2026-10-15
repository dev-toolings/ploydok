// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import { Label } from "@workspace/ui/components/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../i18n/dialog"
import { useUploadCert } from "../../lib/tls-upload"

interface UploadCertDialogProps {
  appId: string
  domain: string
  children: React.ReactNode
}

export function UploadCertDialog({ appId, domain, children }: UploadCertDialogProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const [open, setOpen] = React.useState(false)
  const [cert, setCert] = React.useState("")
  const [key, setKey] = React.useState("")
  const upload = useUploadCert(appId, domain)

  function handleUpload() {
    upload.mutate(
      { cert, key },
      {
        onSuccess: () => {
          setOpen(false)
          setCert("")
          setKey("")
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("domains.uploadTitle")}</DialogTitle>
          <DialogDescription>
            {t("domains.uploadHint", { domain })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cert-pem">{t("domains.certPem")}</Label>
            <Textarea
              id="cert-pem"
              value={cert}
              onChange={(e) => setCert(e.target.value)}
              placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
              className="h-32 font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="key-pem">{t("domains.keyPem")}</Label>
            <Textarea
              id="key-pem"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
              className="h-32 font-mono text-xs"
            />
          </div>

          {upload.isError && (
            <p className="text-xs text-destructive">{upload.error.message}</p>
          )}

          {upload.isSuccess && upload.data && (
            <div className="rounded-md bg-muted p-3 text-xs">
              <p className="font-medium text-green-600">{t("domains.validated")}</p>
              <p>{t("domains.validFrom", { value: upload.data.notBefore ?? "—" })}</p>
              <p>{t("domains.validUntil", { value: upload.data.notAfter ?? "—" })}</p>
              <p>{t("domains.sans", { value: upload.data.sans.join(", ") })}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleUpload}
            loading={upload.isPending} disabled={!cert.trim() || !key.trim()}
          >
            {upload.isPending ? t("domains.uploading") : t("domains.validateUpload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
