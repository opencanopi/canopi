import type { TemplateMeta } from '../../types/community'
import { decodeCanopiDesign } from '../contracts/design-ingestion'
import {
  browserDesignSessionController,
} from '../../web/browser-design-session'
import { WEB_STATIC_DESIGN_TEMPLATE_ASSET_ORIGINS } from '../../web/static-design-templates'
import {
  createDesignTemplateImportCoordinator,
} from './coordinator'
import type { DesignTemplateEnvelope, DesignTemplateImportResult } from './types'

type DesignTemplateOpenResult = 'opened' | 'cancelled'

interface StaticTemplateAssetResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  text(): Promise<string>
}

export interface BrowserDesignTemplateImportAdapters {
  readonly baseUrl?: string
  readonly allowedAssetOrigins?: readonly string[]
  readonly fetchTemplateAsset?: (url: string) => Promise<StaticTemplateAssetResponse>
  readonly openCanopiTemplate?: (
    template: DesignTemplateEnvelope,
    options?: { readonly isCancelled?: () => boolean },
  ) => Promise<DesignTemplateOpenResult>
}

export function createBrowserDesignTemplateImportWorkflow(
  adapters: BrowserDesignTemplateImportAdapters = {},
) {
  return createDesignTemplateImportCoordinator({
    acquire: async (template) => {
      const assetUrl = resolveStaticTemplateAssetUrl(template.download_url, {
        baseUrl: adapters.baseUrl,
        allowedAssetOrigins: adapters.allowedAssetOrigins ?? WEB_STATIC_DESIGN_TEMPLATE_ASSET_ORIGINS,
      })
      const response = await (adapters.fetchTemplateAsset ?? fetchStaticTemplateAsset)(assetUrl.href)

      if (!response.ok) {
        throw new Error(
          `Failed to fetch static Design Template "${template.title}" from ${assetUrl.href}: `
          + `${response.status} ${response.statusText}`.trim(),
        )
      }
      const text = await response.text()
      return decodeCanopiDesign(JSON.parse(text) as unknown)
    },
    open: (envelope, isCancelled) => {
      const openCanopiTemplate = adapters.openCanopiTemplate
        ?? ((envelope, options) => browserDesignSessionController.openCanopiTemplate(
          envelope,
          options,
        ))
      return openCanopiTemplate(envelope, { isCancelled })
    },
  })
}

const defaultWorkflow = createBrowserDesignTemplateImportWorkflow()

export async function importDesignTemplateIntoCurrentSession(
  template: TemplateMeta,
): Promise<DesignTemplateImportResult> {
  return defaultWorkflow.importTemplate(template)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => defaultWorkflow.dispose())
}

function resolveStaticTemplateAssetUrl(
  downloadUrl: string,
  options: Pick<BrowserDesignTemplateImportAdapters, 'baseUrl' | 'allowedAssetOrigins'> = {},
): URL {
  const baseUrl = options.baseUrl ?? globalThis.location?.href ?? 'http://localhost/'
  const base = new URL(baseUrl)
  const assetUrl = new URL(downloadUrl, base)

  if (assetUrl.protocol !== 'http:' && assetUrl.protocol !== 'https:') {
    throw new Error(`Static Design Template asset must use http(s): ${downloadUrl}`)
  }

  if (!assetUrl.pathname.toLowerCase().endsWith('.canopi')) {
    throw new Error(`Static Design Template asset must be a .canopi file: ${downloadUrl}`)
  }

  const allowedOrigins = new Set([base.origin, ...(options.allowedAssetOrigins ?? [])])
  if (!allowedOrigins.has(assetUrl.origin)) {
    throw new Error(`Static Design Template asset origin is not allowed: ${assetUrl.origin}`)
  }

  return assetUrl
}

function fetchStaticTemplateAsset(url: string): Promise<StaticTemplateAssetResponse> {
  return fetch(url)
}
