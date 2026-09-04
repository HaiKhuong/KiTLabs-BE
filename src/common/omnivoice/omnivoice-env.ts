/** OmniVoice device/dtype passed to Python — empty = auto (ưu tiên GPU nếu torch.cuda). */
export function resolveOmnivoiceDeviceMapForPayload(): string {
  return (process.env.OMNIVOICE_DEVICE_MAP ?? "").trim();
}

export function resolveOmnivoiceDtypeForPayload(): string {
  return (process.env.OMNIVOICE_DTYPE ?? "").trim();
}
