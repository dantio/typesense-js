import ApiCall from './ApiCall'
import Collections from './Collections'
import Configuration from './Configuration'
import RequestWithCache from './RequestWithCache'
import { ImportError } from './Errors';

export type FieldType =
  | 'string'
  | 'int32'
  | 'int64'
  | 'float'
  | 'bool'
  | 'string[]'
  | 'int32[]'
  | 'int64[]'
  | 'float[]'
  | 'bool[]'
  | 'auto'
  | 'string*'

export interface CollectionFieldSchema {
  name: string
  type: FieldType
  optional?: boolean
  facet?: boolean
  index?: boolean
}

export interface CollectionCreateSchema {
  name: string
  default_sorting_field: string // Todo: docs say it's not required but api throws a 400 if missing
  fields: CollectionFieldSchema[]
}

export interface CollectionSchema extends CollectionCreateSchema {
  created_at: number
  num_documents: number
  num_memory_shards: number
}

// Todo: use generic to extract filter_by values
export interface DeleteQuery {
  filter_by: string
  batch_size?: number
}

export interface DeleteResponse {
  num_deleted: number
}

interface ImportResponseSuccess {
  success: true
}
interface ImportResponseFail {
  success: false
  error: string
  document: DocumentSchema
  code: number
}
export type ImportResponse = ImportResponseSuccess | ImportResponseFail

export interface DocumentSchema extends Record<string, any> {
  // id?: string //may actually give trouble if someone uses non-string id's
}

export interface SearchParams<T extends DocumentSchema> {
  // From https://typesense.org/docs/0.20.0/api/documents.html#arguments
  q: string
  query_by: string
  query_by_weights?: string
  prefix?: boolean // default: true
  filter_by?: string
  sort_by?: string // default: text match desc
  facet_by?: string
  max_facet_values?: number
  facet_query?: string
  num_typos?: 1 | 2 // default: 2
  page?: number // default: 1
  per_page?: number // default: 10, max 250
  group_by?: keyof T
  group_limit?: number // default:
  include_fields?: string
  exclude_fields?: string
  highlight_full_fields?: string // default: all fields
  highlight_affix_num_tokens?: number // default: 4
  highlight_start_tag?: string // default: <mark>
  highlight_end_tag?: string // default: </mark>
  snippet_threshold?: number // default: 30
  drop_tokens_threshold?: number // default: 10
  typo_tokens_threshold?: number // default: 100
  pinned_hits?: string
  hidden_hits?: string
  limit_hits?: number // default: no limit
  [key: string]: any // allow for future parameters without having to update the library
}

export interface SearchResponseHit<T extends DocumentSchema> {
  highlights?: [
    {
      field: keyof T
      snippet: string
      matched_tokens: string[]
    }
  ]
  document: T
  text_match: number
}

// Todo: we could infer whether this is a grouped response by adding the search params as a generic
export interface SearchResponse<T extends DocumentSchema> {
  facet_counts: any[]
  found: number
  out_of: number
  page: number
  request_params: SearchParams<T>
  search_time_ms: number
  hits?: SearchResponseHit<T>[]
  grouped_hits?: {
    group_key: string[]
    hits: SearchResponseHit<T>[]
  }[]
}

const RESOURCEPATH = '/documents'

export default class Documents<T extends DocumentSchema = {}> {
  private requestWithCache: RequestWithCache

  constructor(private collectionName: string, private apiCall: ApiCall, private configuration: Configuration) {
    this.requestWithCache = new RequestWithCache()
  }

  async create(document: T, options: Record<string, any> = {}): Promise<T> {
    if (!document) throw new Error('No document provided')
    return await this.apiCall.post<T>(this.endpointPath(), document, options)
  }

  upsert(document: T, options: Record<string, any> = {}): Promise<T> {
    if (!document) throw new Error('No document provided')
    return this.apiCall.post<T>(this.endpointPath(), document, Object.assign({}, options, { action: 'upsert' }))
  }

  update(document: T, options: Record<string, any> = {}): Promise<T> {
    if (!document) throw new Error('No document provided')
    return this.apiCall.post<T>(this.endpointPath(), document, Object.assign({}, options, { action: 'update' }))
  }

  delete(idOrQuery: DeleteQuery): Promise<DeleteResponse>
  delete(idOrQuery: string): Promise<T>
  delete(idOrQuery: string | DeleteQuery = {} as DeleteQuery): Promise<DeleteResponse> | Promise<T> {
    if (typeof idOrQuery === 'string') {
      return this.apiCall.delete<T>(this.endpointPath(idOrQuery), idOrQuery)
    } else {
      return this.apiCall.delete<DeleteResponse>(this.endpointPath(), idOrQuery)
    }
  }

  async createMany(documents: T[], options: Record<string, any> = {}) {
    this.configuration.logger.warn(
      'createMany is deprecated and will be removed in a future version. Use import instead, which now takes both an array of documents or a JSONL string of documents'
    )
    return this.import(documents, options)
  }

  /**
   * Import a set of documents in a batch.
   * @param {string|Array} documents - Can be a JSONL string of documents or an array of document objects.
   * @param options
   * @return {string|Array} Returns a JSONL string if the input was a JSONL string, otherwise it returns an array of results.
   */
  async import(documents: string, options?: Record<string, any>): Promise<string>
  async import(documents: T[], options?: Record<string, any>): Promise<ImportResponse[]>
  async import(documents: T[] | string, options: Record<string, any> = {}): Promise<string | ImportResponse[]> {
    let documentsInJSONLFormat
    if (Array.isArray(documents)) {
      documentsInJSONLFormat = documents.map((document) => JSON.stringify(document)).join('\n')
    } else {
      documentsInJSONLFormat = documents
    }

    const resultsInJSONLFormat = await this.apiCall.performRequest<string>('post', this.endpointPath('import'), {
      queryParameters: options,
      bodyParameters: documentsInJSONLFormat,
      additionalHeaders: { 'Content-Type': 'text/plain' }
    })

    if (Array.isArray(documents)) {
        const resultsInJSONFormat = resultsInJSONLFormat.split('\n').map(r => JSON.parse((r))) as ImportResponse[];
        const failedItems = resultsInJSONFormat.filter(r => r.success === false)
        if (failedItems.length > 0) {
          throw new ImportError(`${resultsInJSONFormat.length - failedItems.length} documents imported successfully, ${failedItems.length} documents failed during import. Use \`error.importResults\` from the raised exception to get a detailed error reason for each document.`, resultsInJSONFormat)
        } else {
          return resultsInJSONFormat
        }
    } else {
      return resultsInJSONLFormat as string
    }
  }

  /**
   * Returns a JSONL string for all the documents in this collection
   */
  async export(options: any = {}): Promise<string> {
    return await this.apiCall.get<string>(this.endpointPath('export'), options)
  }

  async search(
    searchParameters: SearchParams<T>,
    { cacheSearchResultsForSeconds = this.configuration.cacheSearchResultsForSeconds, abortSignal = null } = {},
  ): Promise<SearchResponse<T>> {
    let additionalQueryParams = {}
    if (this.configuration.useServerSideSearchCache === true) {
      additionalQueryParams['usecache'] = true
    }
    const queryParams = Object.assign({}, searchParameters, additionalQueryParams)

    return await this.requestWithCache.perform(
      this.apiCall,
      this.apiCall.get,
      [this.endpointPath('search'), queryParams, {abortSignal}],
      {
        cacheResponseForSeconds: cacheSearchResultsForSeconds
      }
    )
  }

  private endpointPath(operation?: string) {
    return `${Collections.RESOURCEPATH}/${this.collectionName}${Documents.RESOURCEPATH}${
      operation === undefined ? '' : '/' + operation
    }`
  }

  static get RESOURCEPATH() {
    return RESOURCEPATH
  }
}
