import { MAX_IMAGE_BYTES } from "./mime.js";

export async function readCappedImageBytes(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("stored image fetch returned no body");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`stored image too large: >${MAX_IMAGE_BYTES} bytes`);
    }
    chunks.push(value);
  }

  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
