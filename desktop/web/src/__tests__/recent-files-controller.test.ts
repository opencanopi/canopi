import { describe, expect, it, vi } from 'vitest'
import { createRecentFilesController } from '../app/recent-files'
import type { RecentDesignSummary } from '../types/design'

vi.mock('../ipc/design', () => ({
  getRecentFiles: vi.fn(),
  getRecentDesignPreviews: vi.fn(async () => []),
  removeRecentDesign: vi.fn(),
  showRecentDesignInFolder: vi.fn(),
}))

describe('recent files controller', () => {
  it('loads and truncates the recent-files list', async () => {
    const loadRecentFiles = vi.fn().mockResolvedValue([
      { path: '/a', name: 'A', updated_at: '2026-04-01T00:00:00.000Z' },
      { path: '/b', name: 'B', updated_at: '2026-04-02T00:00:00.000Z' },
      { path: '/c', name: 'C', updated_at: '2026-04-03T00:00:00.000Z' },
      { path: '/d', name: 'D', updated_at: '2026-04-04T00:00:00.000Z' },
      { path: '/e', name: 'E', updated_at: '2026-04-05T00:00:00.000Z' },
      { path: '/f', name: 'F', updated_at: '2026-04-06T00:00:00.000Z' },
    ])
    const controller = createRecentFilesController({ loadRecentFiles, maxItems: 5 })

    await controller.load()

    expect(controller.recentFiles.value).toHaveLength(5)
    expect(controller.recentFiles.value[0]?.path).toBe('/a')
    expect(controller.recentFiles.value[4]?.path).toBe('/e')
  })

  it('reads previews for the listed Designs without holding up the list', async () => {
    let answer!: (value: RecentDesignSummary[]) => void
    const loadPreviews = vi.fn().mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const controller = createRecentFilesController({
      loadRecentFiles: vi.fn().mockResolvedValue([
        { path: '/a', name: 'A', updated_at: '2026-04-01T00:00:00.000Z' },
        { path: '/b', name: 'B', updated_at: '2026-04-02T00:00:00.000Z' },
      ]),
      loadPreviews,
    })

    await controller.load()
    expect(controller.recentFiles.value).toHaveLength(2)
    expect(controller.previews.value.size).toBe(0)
    expect(loadPreviews).toHaveBeenCalledWith(['/a', '/b'])

    answer([{ path: '/a', preview: { kind: 'unreadable', reason: 'damaged' } }])
    await vi.waitFor(() => expect(controller.previews.value.get('/a')).toEqual({ kind: 'unreadable', reason: 'damaged' }))
    expect(controller.previews.value.has('/b')).toBe(false)

    // A read preview is not asked for again.
    await controller.load()
    expect(loadPreviews).toHaveBeenLastCalledWith(['/b'])
  })

  it('keeps names only when previews cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = createRecentFilesController({
      loadRecentFiles: vi.fn().mockResolvedValue([{ path: '/a', name: 'A', updated_at: '2026-04-01T00:00:00.000Z' }]),
      loadPreviews: vi.fn().mockRejectedValue(new Error('busy')),
    })

    await controller.load()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(controller.recentFiles.value).toHaveLength(1)
    expect(controller.previews.value.size).toBe(0)
    warn.mockRestore()
  })

  it('treats recent-files load failures as a non-fatal empty state', async () => {
    const controller = createRecentFilesController({
      loadRecentFiles: vi.fn().mockRejectedValue(new Error('failed')),
    })

    await controller.load()

    expect(controller.recentFiles.value).toEqual([])
  })

  it('removes a Design from the list and reloads it', async () => {
    const listed = [
      { path: '/a', name: 'A', updated_at: '2026-04-01T00:00:00.000Z' },
      { path: '/b', name: 'B', updated_at: '2026-04-02T00:00:00.000Z' },
    ]
    const loadRecentFiles = vi.fn().mockImplementation(async () => [...listed])
    const removeRecentFile = vi.fn().mockImplementation(async (path: string) => {
      listed.splice(listed.findIndex((file) => file.path === path), 1)
    })
    const controller = createRecentFilesController({ loadRecentFiles, removeRecentFile })
    await controller.load()

    await controller.remove('/a')

    expect(removeRecentFile).toHaveBeenCalledWith('/a')
    expect(controller.recentFiles.value.map((file) => file.path)).toEqual(['/b'])
  })

  it('keeps the list when removing fails', async () => {
    const controller = createRecentFilesController({
      loadRecentFiles: vi.fn().mockResolvedValue([
        { path: '/a', name: 'A', updated_at: '2026-04-01T00:00:00.000Z' },
      ]),
      removeRecentFile: vi.fn().mockRejectedValue(new Error('failed')),
    })
    await controller.load()

    await expect(controller.remove('/a')).rejects.toThrow('failed')
    expect(controller.recentFiles.value.map((file) => file.path)).toEqual(['/a'])
  })
})
