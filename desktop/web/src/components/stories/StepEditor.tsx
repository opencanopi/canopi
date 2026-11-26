import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  canAddStorySteps,
  designEmbeddedImageBytes,
  formatImageBytes,
  goToStepView,
  readStoryImageFile,
  setStepImages,
  setStepText,
  setStepTitle,
  stepsShowingView,
  stepViewTags,
  STORY_IMAGE_ACCEPT,
  useCurrentViewForStep,
  type StoryImageRead,
} from '../../app/stories'
import { currentDesign } from '../../app/document-session/store'
import { STORY_IMAGE_MAX_BYTES } from '../../generated/canopi-design-format'
import { locale } from '../../app/settings/state'
import { t } from '../../i18n'
import type { SavedView, StoryImage, StoryStep } from '../../types/design'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { ControlIcon } from '../shared/ControlIcon'
import { Notice } from '../shared/Notice'
import { RichTextEditor } from './RichTextEditor'
import styles from './StepEditor.module.css'

/** The selected step's editor under the step list: title, text, images and its view. */
export function StepEditor({ storyId, step, number, view }: {
  readonly storyId: string
  readonly step: StoryStep
  readonly number: number
  readonly view: SavedView | null
}) {
  const headingId = useId()
  const titleId = useId()
  const [pending, setPending] = useState<{ src: string; resized: string | null } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [shrinking, setShrinking] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  /** Only the latest chosen file may show: an earlier one still shrinking is dropped. */
  const latestRead = useRef(0)
  const images = step.images ?? []
  const canCapture = canAddStorySteps()
  const shared = view ? stepsShowingView(view.id) - 1 : 0

  async function chooseImage(file: File): Promise<void> {
    const request = ++latestRead.current
    setProblem(null)
    // Making a large image smaller can take a moment.
    setShrinking(file.size > STORY_IMAGE_MAX_BYTES)
    const read = await readStoryImageFile(file, currentDesign.peek())
    if (request !== latestRead.current) return
    setShrinking(false)
    if (read.ok) {
      setPending({
        src: read.src,
        resized: read.resizedFrom === undefined ? null : t('stories.imageResized', {
          from: formatImageBytes(read.resizedFrom, locale.peek()),
          to: formatImageBytes(read.bytes, locale.peek()),
        }),
      })
    }
    else setProblem(imageProblemText(read))
  }

  return (
    <section className={styles.editor} aria-labelledby={headingId} data-step-editor={step.id}>
      <h3 className={styles.heading} id={headingId}>{t('stories.editorHeading', { number })}</h3>
      <label className={styles.field} htmlFor={titleId}>
        <span className={styles.label}>{t('stories.titleLabel')}</span>
        <input
          id={titleId}
          className={styles.input}
          value={step.title}
          onInput={(event) => setStepTitle(storyId, step.id, event.currentTarget.value)}
        />
      </label>
      <RichTextEditor
        value={step.text ?? []}
        onChange={(text) => setStepText(storyId, step.id, text)}
        label={t('stories.textLabel')}
        placeholder={t('stories.textPlaceholder')}
        trailingTools={(
          <button
            type="button"
            className={styles.tool}
            aria-label={t('stories.image')}
            onClick={() => fileInput.current?.click()}
          >
            <ControlIcon name="image" size={16} />
            <ButtonTooltip label={t('stories.image')} side="bottom" />
          </button>
        )}
      />
      <input
        ref={fileInput}
        type="file"
        accept={STORY_IMAGE_ACCEPT}
        className={styles.fileInput}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void chooseImage(file)
        }}
      />
      {shrinking && <p className={styles.hint} role="status">{t('stories.imageShrinking')}</p>}
      {problem && <Notice tone="error">{problem}</Notice>}
      {(images.length > 0 || pending) && (
        <div className={styles.images}>
          <span className={styles.label}>{t('stories.imagesLabel')}</span>
          <ul className={styles.imageList}>
            {images.map((image, index) => (
              <ImageRow
                key={`${index}:${image.src.length}`}
                image={image}
                number={index + 1}
                onAlt={(alt) => {
                  const next = [...images]
                  next[index] = { ...image, alt }
                  setStepImages(storyId, step.id, next)
                }}
                onRemove={() => setStepImages(storyId, step.id, images.filter((_, other) => other !== index))}
              />
            ))}
          </ul>
          {pending && (
            <PendingImage
              key={pending.src}
              src={pending.src}
              resized={pending.resized}
              number={images.length + 1}
              onKeep={(alt) => {
                setStepImages(storyId, step.id, [...images, { src: pending.src, alt }])
                setPending(null)
              }}
              onCancel={() => setPending(null)}
            />
          )}
        </div>
      )}
      <div className={styles.shows}>
        <span className={styles.label}>{t('stories.shows')}</span>
        {view && (
          <ul className={styles.tags}>
            {stepViewTags(view).map((tag) => (
              <li key={tag.key} className={styles.tag} data-tag-kind={tag.kind}>
                {tag.kind === 'view' && <ControlIcon name="camera" size={16} />}
                {tag.label}
              </li>
            ))}
          </ul>
        )}
        {shared > 0 && <p className={styles.hint}>{t('stories.sharedView', { count: shared })}</p>}
        <div className={styles.viewActions}>
          <button
            type="button"
            className={styles.button}
            disabled={!canCapture}
            onClick={() => useCurrentViewForStep(storyId, step.id)}
          >
            <ControlIcon name="camera" size={16} />
            {t('stories.useCurrentView')}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.ghost}`}
            disabled={!canCapture}
            onClick={() => goToStepView(storyId, step.id)}
          >
            {t('stories.goToView')}
          </button>
        </div>
      </div>
    </section>
  )
}

function ImageRow({ image, number, onAlt, onRemove }: {
  readonly image: StoryImage
  readonly number: number
  onAlt(alt: string): void
  onRemove(): void
}) {
  const altId = useId()
  const [draft, setDraft] = useState(image.alt ?? '')
  const missing = draft.trim().length === 0
  return (
    <li className={styles.imageRow}>
      <img className={styles.image} src={image.src} alt={t('stories.imagePreview', { number, alt: image.alt ?? '' })} />
      <label className={styles.field} htmlFor={altId}>
        <span className={styles.label}>{t('stories.imageAltLabel')}</span>
        <input
          id={altId}
          className={styles.input}
          value={draft}
          aria-invalid={missing ? true : undefined}
          onInput={(event) => {
            const value = event.currentTarget.value
            setDraft(value)
            // A description is required: a blank one is never stored.
            if (value.trim().length > 0) onAlt(value.trim())
          }}
        />
        {missing && <span className={styles.error}>{t('stories.imageAltRequired')}</span>}
      </label>
      <button type="button" className={styles.iconButton} aria-label={t('stories.imageRemove', { number })} onClick={onRemove}>
        <ControlIcon name="trash" size={16} />
        <ButtonTooltip label={t('stories.imageRemove', { number })} side="left" />
      </button>
    </li>
  )
}

function PendingImage({ src, resized, number, onKeep, onCancel }: {
  readonly src: string
  /** Says the image was made smaller to fit, and by how much. */
  readonly resized: string | null
  readonly number: number
  onKeep(alt: string): void
  onCancel(): void
}) {
  const altId = useId()
  const hintId = useId()
  const [alt, setAlt] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const ready = alt.trim().length > 0
  useLayoutEffect(() => { field.current?.focus({ preventScroll: true }) }, [])
  return (
    <form
      className={styles.pending}
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) onKeep(alt.trim())
      }}
    >
      <img className={styles.image} src={src} alt="" />
      <label className={styles.field} htmlFor={altId}>
        <span className={styles.label}>{t('stories.imageAltLabel')}</span>
        <input
          id={altId}
          className={styles.input}
          value={alt}
          required
          aria-describedby={hintId}
          ref={field}
          onInput={(event) => setAlt(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }}
        />
        <span className={styles.hint} id={hintId}>{t('stories.imageAltHint')}</span>
      </label>
      {resized && <p className={`${styles.hint} ${styles.resized}`} role="status">{resized}</p>}
      <div className={styles.pendingActions}>
        <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={onCancel}>{t('stories.cancel')}</button>
        <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={!ready} data-image-number={number}>
          {t('stories.imageKeep')}
        </button>
      </div>
    </form>
  )
}

function imageProblemText(read: Extract<StoryImageRead, { ok: false }>): string {
  switch (read.problem) {
    case 'type': return t('stories.imageType')
    case 'tooLarge': return t('stories.imageTooLarge', { size: formatImageBytes(read.bytes, locale.peek()) })
    case 'designFull': return t('stories.imageDesignFull', {
      used: formatImageBytes(designEmbeddedImageBytes(currentDesign.peek()), locale.peek()),
    })
    case 'unreadable': return t('stories.imageUnreadable')
  }
}
