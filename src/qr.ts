import QRCode from "qrcode";

/**
 * Render `text` to a QR code as an SVG string. We use SVG (not a raster data
 * URL) so it stays crisp at any modal size and needs no <img> load round-trip.
 */
export async function qrSvg(text: string, dark = "#0f1115", light = "#ffffff"): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark, light },
  });
}
