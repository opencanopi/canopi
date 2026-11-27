import {
  STORY_IMAGE_DATA_TYPES,
  STORY_IMAGE_MAX_BYTES,
  STORY_IMAGES_MAX_TOTAL_BYTES,
} from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'
import { formatByteSize } from '../../utils/format'
import { designEmbeddedImageBytes, embeddedImageBytes } from '../contracts/views-admission'

export { designEmbeddedImageBytes }

// Story images are embedded in the Design as base64 `data:` URIs (decision D1):
// PNG, JPEG, WebP or GIF, at most 1 MiB each and 10 MiB per Design, the same
// limits the file admission checks (views-admission.ts). A chosen image over
// 1 MiB is made smaller in the browser (a canvas, then WebP, or JPEG where the
// browser cannot write WebP, at falling quality and size) until it fits.

type StoryImageProblem = 'type' | 'tooLarge' | 'designFull' | 'unreadable'

export type StoryImageRead =
  | {
    readonly ok: true
    readonly src: string
    readonly bytes: number
    /** The chosen file's size when Canopi made the image smaller to fit. */
    readonly resizedFrom?: number
  }
  | { readonly ok: false; readonly problem: StoryImageProblem; readonly bytes: number }

type ShrinkType = 'image/webp' | 'image/jpeg'

/** A decoded image that can be drawn again at another size and encoded. */
interface DecodedStoryImage {
  readonly width: number
  readonly height: number
  /** Null when the browser cannot encode; the blob's type says what it wrote. */
  encode(width: number, height: number, type: ShrinkType, quality: number): Promise<Blob | null>
  close(): void
}

export interface StoryImageDecoder {
  /** Null when the file cannot be decoded as an image. */
  decode(file: Blob): Promise<DecodedStoryImage | null>
}

/** The long side of a shrunk image starts at most here (enough for a full-window step). */
const SHRINK_MAX_EDGE_PX = 2560
/** Below this long side the image is no use; the file is refused instead. */
const SHRINK_MIN_EDGE_PX = 320
const SHRINK_QUALITIES = [0.86, 0.76, 0.64, 0.52] as const
const SHRINK_SCALE_STEP = 0.75

/** The file types an image picker offers. */
export const STORY_IMAGE_ACCEPT = STORY_IMAGE_DATA_TYPES.join(',')

/**
 * Reads a chosen image file as a data URI when the Design can hold it: a
 * supported type, at most 1 MiB (made smaller first when it is over), and
 * within the Design's 10 MiB of images.
 */
export async function readStoryImageFile(
  file: Pick<File, 'type' | 'size'> & Blob,
  design: Pick<CanopiFile, 'stories'> | null,
  decoder: StoryImageDecoder = browserStoryImageDecoder,
): Promise<StoryImageRead> {
  const bytes = file.size
  if (!(STORY_IMAGE_DATA_TYPES as readonly string[]).includes(file.type)) return { ok: false, problem: 'type', bytes }
  let image: Blob = file
  if (bytes > STORY_IMAGE_MAX_BYTES) {
    const shrunk = await shrinkImage(file, decoder)
    if (shrunk === 'unreadable' || shrunk === 'tooLarge') return { ok: false, problem: shrunk, bytes }
    image = shrunk
  }
  if (designEmbeddedImageBytes(design) + image.size > STORY_IMAGES_MAX_TOTAL_BYTES) {
    return { ok: false, problem: 'designFull', bytes: image.size }
  }
  try {
    const src = await readAsDataUrl(image)
    const prefix = `data:${image.type};base64,`
    if (!src.startsWith(prefix) || embeddedImageBytes(src) !== image.size) return { ok: false, problem: 'unreadable', bytes }
    return image === file ? { ok: true, src, bytes } : { ok: true, src, bytes: image.size, resizedFrom: bytes }
  } catch {
    return { ok: false, problem: 'unreadable', bytes }
  }
}

/**
 * Draws the image smaller until it encodes within 1 MiB: at most 2560 px on
 * the long side, lower quality first, then three quarters of the size, down
 * to 320 px.
 */
async function shrinkImage(file: Blob, decoder: StoryImageDecoder): Promise<Blob | 'unreadable' | 'tooLarge'> {
  let decoded: DecodedStoryImage | null
  try {
    decoded = await decoder.decode(file)
  } catch {
    decoded = null
  }
  if (!decoded || decoded.width < 1 || decoded.height < 1) return 'unreadable'
  const image = decoded
  try {
    const longSide = Math.max(image.width, image.height)
    let type: ShrinkType = 'image/webp'
    for (let scale = Math.min(1, SHRINK_MAX_EDGE_PX / longSide); longSide * scale >= SHRINK_MIN_EDGE_PX; scale *= SHRINK_SCALE_STEP) {
      const width = Math.max(1, Math.round(image.width * scale))
      const height = Math.max(1, Math.round(image.height * scale))
      for (const quality of SHRINK_QUALITIES) {
        let blob = await image.encode(width, height, type, quality)
        // A browser that cannot write WebP answers with PNG: use JPEG from now on.
        if (blob && blob.type !== type && type === 'image/webp') {
          type = 'image/jpeg'
          blob = await image.encode(width, height, type, quality)
        }
        if (!blob || blob.type !== type) return 'unreadable'
        if (blob.size <= STORY_IMAGE_MAX_BYTES) return blob
      }
    }
    return 'tooLarge'
  } catch {
    return 'unreadable'
  } finally {
    image.close()
  }
}

/** Decodes with `createImageBitmap` and encodes through a canvas. */
const browserStoryImageDecoder: StoryImageDecoder = {
  async decode(file) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
    const bitmap = await createImageBitmap(file)
    return {
      width: bitmap.width,
      height: bitmap.height,
      encode(width, height, type, quality) {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) return Promise.resolve(null)
        // JPEG has no transparency: transparent pixels become white, not black.
        if (type === 'image/jpeg') {
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, width, height)
        }
        context.imageSmoothingQuality = 'high'
        context.drawImage(bitmap, 0, 0, width, height)
        return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
      },
      close() {
        bitmap.close()
      },
    }
  },
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('unreadable'))
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
    reader.readAsDataURL(file)
  })
}


/** An image size for people in decimal SI (2.1-Q359): "1.5 MB" in the interface language. */
export function formatImageBytes(bytes: number, locale: string): string {
  return formatByteSize(bytes, locale)
}
