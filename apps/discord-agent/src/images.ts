import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { SNOWFLAKE, type IncomingImage } from "./config.js";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
]);
export interface SavedImage {
  mediaType: string;
  sha256: string;
  data: Uint8Array;
}

/** Validate the file signature and dimensions before a decoder or model sees it. */
export function validateImage(data: Uint8Array, mediaType: string): void {
  if (!TYPES.has(mediaType) || !data.length || data.length > MAX_IMAGE_BYTES)
    throw new Error("Unsupported image type or size");
  const bytes = Buffer.from(data);
  let width = 0,
    height = 0;
  if (
    mediaType === "image/png" &&
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    // Bound animation as well as canvas dimensions; this adapter accepts still images.
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      if (offset + length + 12 > bytes.length)
        throw new Error("Truncated PNG chunk");
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL")
        throw new Error("Animated images are unsupported");
      offset += length + 12;
    }
  } else if (
    mediaType === "image/jpeg" &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8
  ) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        length >= 8
      ) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    mediaType === "image/webp" &&
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X" && bytes.readUInt32LE(16) === 10 && !(bytes[20]! & 2)) {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (
      kind === "VP8 " &&
      bytes.length >= 30 &&
      bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (
    !width ||
    !height ||
    width > 16_384 ||
    height > 16_384 ||
    width * height > MAX_PIXELS
  )
    throw new Error("Invalid image signature or dimensions");
}
export function imageDigest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
export function validateSavedImages(images: readonly SavedImage[]): void {
  if (
    images.length > MAX_IMAGES ||
    images.reduce((sum, image) => sum + image.data.length, 0) >
      MAX_TOTAL_IMAGE_BYTES
  )
    throw new Error("Image count or total size limit");
  for (const image of images) {
    validateImage(image.data, image.mediaType);
    if (image.sha256 !== imageDigest(image.data))
      throw new Error("Image digest mismatch");
  }
}
function attachmentUrl(image: IncomingImage, threadId: string): URL {
  const url = new URL(image.url);
  const parts = url.pathname.split("/");
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    parts.length !== 5 ||
    parts[1] !== "attachments" ||
    parts[2] !== threadId ||
    parts[3] !== image.id ||
    !parts[4] ||
    !SNOWFLAKE.test(image.id)
  )
    throw new Error("Invalid Discord attachment URL");
  return url;
}
/** Caller must authorize the owner and forum thread before entering this function. */
export async function downloadImages(
  images: readonly IncomingImage[],
  threadId: string,
  fetchImage: typeof fetch = fetch,
  cancel?: AbortSignal,
): Promise<SavedImage[]> {
  if (
    !images.length ||
    images.length > MAX_IMAGES ||
    images.some(
      (image) =>
        !Number.isSafeInteger(image.size) ||
        image.size < 1 ||
        image.size > MAX_IMAGE_BYTES ||
        !TYPES.has(image.contentType ?? ""),
    ) ||
    images.reduce((sum, image) => sum + image.size, 0) > MAX_TOTAL_IMAGE_BYTES
  )
    throw new Error("Image count, type or size limit");
  // Validate the entire batch before the first network request.
  const urls = images.map((image) => attachmentUrl(image, threadId));
  const signal = AbortSignal.any([
    AbortSignal.timeout(15_000),
    ...(cancel ? [cancel] : []),
  ]);
  const saved: SavedImage[] = [];
  let total = 0;
  for (let i = 0; i < images.length; i++) {
    signal.throwIfAborted();
    const image = images[i]!;
    const response = await fetchImage(urls[i]!, {
      redirect: "error",
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    const type = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const length = response.headers.get("content-length");
    if (
      !response.ok ||
      !response.body ||
      type !== image.contentType ||
      (length !== null &&
        (!/^\d+$/.test(length) || Number(length) !== image.size))
    ) {
      await response.body?.cancel();
      throw new Error("Attachment response rejected");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        total += chunk.value.length;
        if (
          bytes > image.size ||
          bytes > MAX_IMAGE_BYTES ||
          total > MAX_TOTAL_IMAGE_BYTES
        )
          throw new Error("Attachment byte limit");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (bytes !== image.size) throw new Error("Attachment size mismatch");
    const data = Buffer.concat(chunks);
    validateImage(data, type!);
    saved.push({ mediaType: type!, sha256: imageDigest(data), data });
  }
  return saved;
}

/** Bytes live durably in SQLite; runner files are private, temporary and disposable. */
async function privateStateRoot(stateDir: string): Promise<string> {
  const base = await realpath(stateDir);
  const info = await stat(base);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Image state directory must be owned and private");
  return base;
}
/** Startup holds the external singleton lock, so prior turn files are abandoned. */
export async function cleanupStaleImages(stateDir: string): Promise<void> {
  const base = await privateStateRoot(stateDir);
  for (const entry of await readdir(base, { withFileTypes: true }))
    if (
      /^\.turn-images-[A-Za-z0-9]{6}$/.test(entry.name) &&
      entry.isDirectory()
    )
      await rm(join(base, entry.name), { recursive: true, force: true });
}
export async function materializeImages(
  stateDir: string,
  images: readonly SavedImage[],
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  validateSavedImages(images);
  const base = await privateStateRoot(stateDir);
  const directory = await mkdtemp(join(base, ".turn-images-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await chmod(directory, 0o700);
    const paths = [];
    for (const [index, image] of images.entries()) {
      const path = join(directory, `${index}${TYPES.get(image.mediaType)}`);
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(image.data);
      } finally {
        await file.close();
      }
      paths.push(path);
    }
    return { paths, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
