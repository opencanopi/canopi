import {
  RICH_TEXT_LINK_SCHEMES,
  SAVED_VIEW_MAX_GROUND_SIZE_M,
  STORY_IMAGE_DATA_TYPES,
  STORY_IMAGE_MAX_BYTES,
  STORY_IMAGES_MAX_TOTAL_BYTES,
} from '../../generated/canopi-design-format'
import type { CanopiFile, RichTextBlock, RichTextSpan, SavedView, Story } from '../../types/design'

/** Mirrors canopi_types::views::validate_map_view: the view a Design was saved with, by the saved-view camera rules. */
export function mapViewProblem(mapView: SavedView['camera'] | null | undefined): string | null {
  return mapView ? groundSizeProblem(mapView, '$.map_view') : null
}

// Mirrors canopi_types::views::validate_views_and_stories. The generated schema
// already bounds each camera when a file is read; this checks recorded ground
// sizes (Design edits never pass the schema), ids, cross-references, link
// schemes and embedded images. Returns the first problem as "$.path: reason".
export function viewsAndStoriesProblem(
  views: readonly SavedView[],
  stories: readonly Story[],
): string | null {
  const viewIds = new Set<string>()
  for (const [index, view] of views.entries()) {
    if (viewIds.has(view.id)) return `$.views[${index}].id: duplicate saved view id ${JSON.stringify(view.id)}`
    viewIds.add(view.id)
    const problem = groundSizeProblem(view.camera, `$.views[${index}].camera`)
      ?? richTextProblem(view.text ?? [], `$.views[${index}].text`)
    if (problem) return problem
  }

  const storyIds = new Set<string>()
  let embeddedBytes = 0
  for (const [storyIndex, story] of stories.entries()) {
    if (storyIds.has(story.id)) return `$.stories[${storyIndex}].id: duplicate story id ${JSON.stringify(story.id)}`
    storyIds.add(story.id)
    const stepIds = new Set<string>()
    for (const [stepIndex, step] of story.steps.entries()) {
      const path = `$.stories[${storyIndex}].steps[${stepIndex}]`
      if (stepIds.has(step.id)) return `${path}.id: duplicate step id ${JSON.stringify(step.id)}`
      stepIds.add(step.id)
      if (!viewIds.has(step.view_id)) return `${path}.view_id: no saved view ${JSON.stringify(step.view_id)}`
      const textProblem = richTextProblem(step.text ?? [], `${path}.text`)
      if (textProblem) return textProblem
      for (const [imageIndex, image] of (step.images ?? []).entries()) {
        const imagePath = `${path}.images[${imageIndex}].src`
        const bytes = storyImageEmbeddedBytes(image.src)
        if (typeof bytes === 'string') return `${imagePath}: ${bytes}`
        if (bytes > STORY_IMAGE_MAX_BYTES) {
          return `${imagePath}: an embedded image holds at most ${STORY_IMAGE_MAX_BYTES} bytes`
        }
        embeddedBytes += bytes
        if (embeddedBytes > STORY_IMAGES_MAX_TOTAL_BYTES) {
          return `${imagePath}: a Design embeds at most ${STORY_IMAGES_MAX_TOTAL_BYTES} bytes of images`
        }
      }
    }
  }
  return null
}

/** The schema already bounds the camera itself when a file is read; this checks its recorded ground. */
function groundSizeProblem(camera: SavedView['camera'], path: string): string | null {
  return !isAdmittedGroundSize(camera.ground_size_m)
    ? `${path}.ground_size_m: expected a finite width and height above 0 and at most ${SAVED_VIEW_MAX_GROUND_SIZE_M} m`
    : null
}

/** Whether a saved view's recorded ground is one the format admits: finite, above 0 and at most 1e8 m on each side. */
function isAdmittedGroundSize(ground: { readonly width: number; readonly height: number }): boolean {
  return [ground.width, ground.height].every((side) => Number.isFinite(side) && side > 0 && side <= SAVED_VIEW_MAX_GROUND_SIZE_M)
}

/** Whether a viewer may open this rich-text link (https:, http: or mailto:), in any case. */
export function isAllowedRichTextLink(link: string): boolean {
  const lower = link.slice(0, 7).toLowerCase()
  return RICH_TEXT_LINK_SCHEMES.some((scheme) => lower.startsWith(scheme))
}

function richTextProblem(blocks: readonly RichTextBlock[], path: string): string | null {
  for (const [blockIndex, block] of blocks.entries()) {
    const problem = block.kind === 'paragraph'
      ? spansProblem(block.spans, `${path}[${blockIndex}]`)
      : block.items.reduce<string | null>(
        (found, item, itemIndex) => found ?? spansProblem(item.spans, `${path}[${blockIndex}].items[${itemIndex}]`),
        null,
      )
    if (problem) return problem
  }
  return null
}

function spansProblem(spans: readonly RichTextSpan[], path: string): string | null {
  for (const [index, span] of spans.entries()) {
    if (span.link != null && !isAllowedRichTextLink(span.link)) {
      return `${path}.spans[${index}].link: links must be https:, http: or mailto:`
    }
  }
  return null
}

const BASE64_BODY = /^[A-Za-z0-9+/]*$/

/** Decoded bytes of a base64 `data:` URI; 0 for a link or anything else. */
export function embeddedImageBytes(src: string): number {
  const marker = src.indexOf(';base64,')
  if (!src.startsWith('data:') || marker === -1) return 0
  const payload = src.slice(marker + ';base64,'.length)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor(payload.length / 4) * 3 - padding
}

/** Decoded bytes of every image a Design embeds. */
export function designEmbeddedImageBytes(design: Pick<CanopiFile, 'stories'> | null): number {
  let bytes = 0
  for (const story of design?.stories ?? []) {
    for (const step of story.steps) {
      for (const image of step.images ?? []) bytes += embeddedImageBytes(image.src)
    }
  }
  return bytes
}

/** Decoded bytes an image source embeds (0 for an https: link), or why it is refused. */
function storyImageEmbeddedBytes(src: string): number | string {
  if (src.slice(0, 6).toLowerCase() === 'https:') return 0
  const invalidSource = 'images must be https: links or embedded PNG, JPEG, WebP or GIF data'
  if (!src.startsWith('data:')) return invalidSource
  const marker = src.indexOf(';base64,')
  if (marker === -1) return 'an embedded image must be base64 data'
  const mediaType = src.slice('data:'.length, marker)
  if (!(STORY_IMAGE_DATA_TYPES as readonly string[]).includes(mediaType)) return invalidSource
  const payload = src.slice(marker + ';base64,'.length)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  if (payload.length % 4 !== 0 || !BASE64_BODY.test(payload.slice(0, payload.length - padding))) {
    return 'an embedded image must be valid base64 data'
  }
  return embeddedImageBytes(src)
}
