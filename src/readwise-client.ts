import {
  ReadwiseDocument,
  CreateDocumentRequest,
  UpdateDocumentRequest,
  ListDocumentsParams,
  ListDocumentsResponse,
  ReadwiseTag,
  ReadwiseConfig,
  APIResponse,
  APIMessage
} from './types.js';

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

export class ReadwiseClient {
  private readonly baseUrl = 'https://readwise.io/api/v3';
  private readonly authUrl = 'https://readwise.io/api/v2/auth/';
  private readonly token: string;
  private readonly retryConfig: RetryConfig;

  constructor(config: ReadwiseConfig & { retry?: Partial<RetryConfig> }) {
    this.token = config.token;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retry };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Token ${this.token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      if (response.ok) {
        // Handle 204 No Content responses (e.g., DELETE requests)
        if (response.status === 204) {
          return undefined as T;
        }
        return response.json();
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : 60;

        // Calculate delay: use Retry-After header or exponential backoff
        const exponentialDelay = Math.min(
          this.retryConfig.baseDelayMs * Math.pow(2, attempt),
          this.retryConfig.maxDelayMs
        );
        const delayMs = Math.min(retryAfterSeconds * 1000, this.retryConfig.maxDelayMs);
        const actualDelay = Math.max(delayMs, exponentialDelay);

        if (attempt < this.retryConfig.maxRetries) {
          console.warn(`Rate limited. Retrying in ${Math.round(actualDelay / 1000)}s (attempt ${attempt + 1}/${this.retryConfig.maxRetries})...`);
          await this.sleep(actualDelay);
          continue;
        }

        lastError = new Error(
          `Rate limit exceeded after ${this.retryConfig.maxRetries} retries. ` +
          `Please wait ${retryAfterSeconds} seconds before trying again.`
        );
      } else {
        const errorText = await response.text();
        lastError = new Error(`Readwise API error: ${response.status} ${response.statusText} - ${errorText}`);
        break; // Don't retry non-rate-limit errors
      }
    }

    throw lastError || new Error('Request failed');
  }

  private createResponse<T>(data: T, messages?: APIMessage[]): APIResponse<T> {
    return { data, messages };
  }

  private createInfoMessage(content: string): APIMessage {
    return { type: 'info', content };
  }

  private createErrorMessage(content: string): APIMessage {
    return { type: 'error', content };
  }

  async validateAuth(): Promise<APIResponse<{ detail: string }>> {
    const result = await this.makeRequest<{ detail: string }>(this.authUrl);
    return this.createResponse(result);
  }

  async createDocument(data: CreateDocumentRequest): Promise<APIResponse<ReadwiseDocument>> {
    const result = await this.makeRequest<ReadwiseDocument>('/save/', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return this.createResponse(result);
  }

  async listDocuments(params: ListDocumentsParams = {}): Promise<APIResponse<ListDocumentsResponse>> {
    // If withFullContent is requested, first check the document count
    if (params.withFullContent) {
      const countParams = { ...params };
      delete countParams.withFullContent;
      delete countParams.withHtmlContent; // Also remove HTML content for the count check

      const countSearchParams = new URLSearchParams();
      Object.entries(countParams).forEach(([key, value]) => {
        if (value !== undefined) {
          countSearchParams.append(key, String(value));
        }
      });

      const countQuery = countSearchParams.toString();
      const countEndpoint = `/list/${countQuery ? `?${countQuery}` : ''}`;

      const countResponse = await this.makeRequest<ListDocumentsResponse>(countEndpoint);

      if (countResponse.count > 5) {
        // Get first 5 documents with full content
        const limitedParams = { ...params, limit: 5 };
        const searchParams = new URLSearchParams();

        Object.entries(limitedParams).forEach(([key, value]) => {
          if (value !== undefined) {
            searchParams.append(key, String(value));
          }
        });

        const query = searchParams.toString();
        const endpoint = `/list/${query ? `?${query}` : ''}`;

        const result = await this.makeRequest<ListDocumentsResponse>(endpoint);

        let message: APIMessage;
        if (countResponse.count <= 20) {
          message = this.createInfoMessage(
            `Found ${countResponse.count} documents, but only returning the first 5 due to full content request. ` +
            `To get the remaining ${countResponse.count - 5} documents with full content, ` +
            `you can fetch them individually by their IDs using the update/read document API.`
          );
        } else {
          message = this.createErrorMessage(
            `Found ${countResponse.count} documents, but only returning the first 5 due to full content request. ` +
            `Getting full content for more than 20 documents is not supported due to performance limitations.`
          );
        }

        return this.createResponse(result, [message]);
      }
    }

    const searchParams = new URLSearchParams();

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        searchParams.append(key, String(value));
      }
    });

    const query = searchParams.toString();
    const endpoint = `/list/${query ? `?${query}` : ''}`;

    const result = await this.makeRequest<ListDocumentsResponse>(endpoint);
    return this.createResponse(result);
  }

  async updateDocument(id: string, data: UpdateDocumentRequest): Promise<APIResponse<ReadwiseDocument>> {
    const result = await this.makeRequest<ReadwiseDocument>(`/update/${id}/`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return this.createResponse(result);
  }

  async deleteDocument(id: string): Promise<APIResponse<void>> {
    await this.makeRequest(`/delete/${id}/`, {
      method: 'DELETE',
    });
    return this.createResponse(undefined);
  }

  async listTags(): Promise<APIResponse<ReadwiseTag[]>> {
    const result = await this.makeRequest<ReadwiseTag[]>('/tags/');
    return this.createResponse(result);
  }

  async searchDocumentsByTopic(searchTerms: string[]): Promise<APIResponse<ReadwiseDocument[]>> {
    // Fetch all documents without full content for performance
    const allDocuments: ReadwiseDocument[] = [];
    let nextPageCursor: string | undefined;

    do {
      const params: ListDocumentsParams = {
        withFullContent: false,
        withHtmlContent: false,
      };

      if (nextPageCursor) {
        params.pageCursor = nextPageCursor;
      }

      const response = await this.listDocuments(params);
      allDocuments.push(...response.data.results);
      nextPageCursor = response.data.nextPageCursor;
    } while (nextPageCursor);

    // Create regex patterns from search terms (case-insensitive)
    const regexPatterns = searchTerms.map(term =>
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    );

    // Filter documents that match any of the search terms
    const matchingDocuments = allDocuments.filter(doc => {
      // Extract searchable text fields
      const searchableFields = [
        doc.title || '',
        doc.summary || '',
        doc.notes || '',
        // Handle tags - they can be string array or object
        Array.isArray(doc.tags) ? doc.tags.join(' ') : '',
      ];

      const searchableText = searchableFields.join(' ').toLowerCase();

      // Check if any regex pattern matches
      return regexPatterns.some(pattern => pattern.test(searchableText));
    });

    return this.createResponse(matchingDocuments);
  }
}