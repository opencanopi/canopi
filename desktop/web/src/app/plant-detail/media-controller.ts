import { signal, type Signal } from '@preact/signals'
import { getCachedImagePath, getSpeciesImages, resolveAssetUrl } from '../../ipc/species'
import type { SpeciesImage } from '../../types/species'

export interface PlantMediaController {
  images: Signal<SpeciesImage[]>
  currentIndex: Signal<number>
  loadedSrc: Signal<string | null>
  imageReady: Signal<boolean>
  loadFailed: Signal<boolean>
  loading: Signal<boolean>
  setCanonicalName(canonicalName: string): void
  goNext(): void
  goPrev(): void
  setCurrentIndex(nextIndex: number): void
  markImageLoaded(): void
  handleImageError(): void
  dispose(): void
}

interface CreatePlantMediaControllerOptions {
  loadImages?: typeof getSpeciesImages
  loadCachedImagePath?: typeof getCachedImagePath
  toAssetUrl?: (path: string) => string
}

export function createPlantMediaController(
  options: CreatePlantMediaControllerOptions = {},
): PlantMediaController {
  const loadImages = options.loadImages ?? getSpeciesImages
  const loadCachedImagePath = options.loadCachedImagePath ?? getCachedImagePath
  const toAssetUrl = options.toAssetUrl ?? ((localFile: string) => resolveAssetUrl(localFile) ?? localFile)

  const images = signal<SpeciesImage[]>([])
  const currentIndex = signal(0)
  const loadedSrc = signal<string | null>(null)
  const imageReady = signal(false)
  const loadFailed = signal(false)
  const loading = signal(true)

  let currentCanonicalName = ''
  let listGeneration = 0
  let imageGeneration = 0
  let disposed = false

  function resetImageState(): void {
    loadedSrc.value = null
    imageReady.value = false
    loadFailed.value = false
  }

  function loadCurrentImage(): void {
    const currentImage = images.value[currentIndex.value]
    if (!currentImage) return

    resetImageState()
    const requestGeneration = ++imageGeneration
    const preloadIndices = [currentIndex.value - 1, currentIndex.value + 1]
      .filter((index) => index >= 0 && index < images.value.length)

    void loadCachedImagePath(currentImage.url)
      .then((cachePath) => {
        if (disposed || requestGeneration !== imageGeneration) return
        loadedSrc.value = toAssetUrl(cachePath)
      })
      .catch(() => {
        if (disposed || requestGeneration !== imageGeneration) return
        loadedSrc.value = currentImage.url
      })

    for (const preloadIndex of preloadIndices) {
      const preloadImage = images.value[preloadIndex]
      if (!preloadImage) continue
      void loadCachedImagePath(preloadImage.url).catch(() => {
        // Best-effort prewarm only.
      })
    }
  }

  function setCanonicalName(canonicalName: string): void {
    if (canonicalName === currentCanonicalName) return
    currentCanonicalName = canonicalName

    const requestGeneration = ++listGeneration
    imageGeneration += 1
    images.value = []
    currentIndex.value = 0
    resetImageState()
    loading.value = true

    void loadImages(canonicalName)
      .then((nextImages) => {
        if (disposed || requestGeneration !== listGeneration) return
        images.value = nextImages
        currentIndex.value = 0
        loading.value = false
        if (nextImages.length > 0) {
          loadCurrentImage()
        }
      })
      .catch(() => {
        if (disposed || requestGeneration !== listGeneration) return
        loading.value = false
      })
  }

  function setCurrentIndex(nextIndex: number): void {
    if (nextIndex < 0 || nextIndex >= images.value.length) return
    if (nextIndex === currentIndex.value) return
    currentIndex.value = nextIndex
    loadCurrentImage()
  }

  function goNext(): void {
    if (images.value.length <= 1) return
    currentIndex.value = (currentIndex.value + 1) % images.value.length
    loadCurrentImage()
  }

  function goPrev(): void {
    if (images.value.length <= 1) return
    currentIndex.value = (currentIndex.value - 1 + images.value.length) % images.value.length
    loadCurrentImage()
  }

  function markImageLoaded(): void {
    imageReady.value = true
  }

  function handleImageError(): void {
    const currentImage = images.value[currentIndex.value]
    if (!currentImage) return

    if (loadedSrc.value !== currentImage.url) {
      loadedSrc.value = currentImage.url
      imageReady.value = false
      loadFailed.value = false
      return
    }

    loadedSrc.value = null
    imageReady.value = false
    loadFailed.value = true
  }

  function dispose(): void {
    disposed = true
    listGeneration += 1
    imageGeneration += 1
  }

  return {
    images,
    currentIndex,
    loadedSrc,
    imageReady,
    loadFailed,
    loading,
    setCanonicalName,
    goNext,
    goPrev,
    setCurrentIndex,
    markImageLoaded,
    handleImageError,
    dispose,
  }
}
