import { writeFileSync } from 'fs';
import { join } from 'path';

/**
 * OpenAPI 3.1 contract for fda-data /v1 (ADR-017). @medexregai/fda-sdk is written
 * against it; `npm run openapi` writes services/fda-data/openapi.json.
 */
const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const ndate = { type: ['string', 'null'], format: 'date' };
const int = { type: 'integer' };
const nint = { type: ['integer', 'null'] };
const bool = { type: 'boolean' };
const strs = { type: 'array', items: str };

const ok = (schema: object) => ({
  type: 'object',
  required: ['success', 'data'],
  properties: { success: { const: true }, data: schema },
});
const page = (item: string) => ({
  type: 'object',
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', items: { $ref: `#/components/schemas/${item}` } },
    nextCursor: nstr,
  },
});
const json = (schema: object) => ({
  content: { 'application/json': { schema } },
});
const errors = {
  '400': {
    description: 'Malformed parameter (VALIDATION_ERROR)',
    ...json({ $ref: '#/components/schemas/Error' }),
  },
  '401': {
    description: 'Missing, invalid or revoked API key (UNAUTHORIZED)',
    ...json({ $ref: '#/components/schemas/Error' }),
  },
  '403': {
    description: 'Key lacks the fda:read scope (FORBIDDEN)',
    ...json({ $ref: '#/components/schemas/Error' }),
  },
  '429': {
    description: 'Client rate limit exceeded (RATE_LIMITED); see Retry-After',
    ...json({ $ref: '#/components/schemas/Error' }),
  },
};
const notFound = {
  '404': {
    description: 'Not in the FDA copy (NOT_FOUND)',
    ...json({ $ref: '#/components/schemas/Error' }),
  },
};
const pathParam = (name: string, pattern: string, example: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', pattern },
  example,
});
const query = (name: string, schema: object, required = false) => ({
  name,
  in: 'query',
  required,
  schema,
});
const K = '^(K|DEN)\\d{6}$';
const CODE = '^[A-Za-z]{3}$';
const listParams = [query('limit', { type: 'integer', minimum: 1, maximum: 100, default: 25 }), query('cursor', str)];

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'MedexRegAI fda-data API',
    version: '1.0.0',
    description:
      'Public FDA device data (openFDA 510(k), classification, recall, GUDID, MAUDE counts) held in its own database. Service-to-service only: send X-Api-Key. Responses carry a weak ETag; send If-None-Match to get 304.',
  },
  servers: [{ url: 'http://localhost:4100' }],
  security: [{ ApiKey: [] }],
  paths: {
    '/v1/meta': {
      get: {
        operationId: 'getMeta',
        summary: 'Data freshness per dataset',
        responses: {
          '200': {
            description: 'OK',
            ...json(ok({ $ref: '#/components/schemas/Meta' })),
          },
          ...errors,
        },
      },
    },
    '/v1/510k/{kNumber}': {
      get: {
        operationId: 'getClearance',
        summary: 'Verify a K or DEN number',
        parameters: [pathParam('kNumber', K, 'K031698')],
        responses: {
          '200': {
            description: 'OK',
            ...json(ok({ $ref: '#/components/schemas/Clearance' })),
          },
          ...errors,
          ...notFound,
        },
      },
    },
    '/v1/510k': {
      get: {
        operationId: 'search510k',
        summary: 'Search 510(k)s, newest decision first (at least one filter)',
        parameters: [
          query('productCode', { type: 'string', pattern: CODE }),
          query('applicant', { type: 'string', minLength: 2, maxLength: 100 }),
          query('q', {
            type: 'string',
            minLength: 2,
            maxLength: 100,
            description: 'Device-name substring',
          }),
          query('decidedFrom', { type: 'string', format: 'date' }),
          query('decidedTo', { type: 'string', format: 'date' }),
          ...listParams,
        ],
        responses: {
          '200': { description: 'OK', ...json(ok(page('ClearanceSummary'))) },
          ...errors,
        },
      },
    },
    '/v1/product-codes/{code}': {
      get: {
        operationId: 'getProductCode',
        summary: 'Device class and regulation number of a product code',
        parameters: [pathParam('code', CODE, 'FRN')],
        responses: {
          '200': {
            description: 'OK',
            ...json(ok({ $ref: '#/components/schemas/ProductCode' })),
          },
          ...errors,
          ...notFound,
        },
      },
    },
    '/v1/flags/{kNumber}': {
      get: {
        operationId: 'getFlags',
        summary: 'Recall and MAUDE flags for a K-number',
        parameters: [pathParam('kNumber', K, 'K251636')],
        responses: {
          '200': {
            description: 'OK',
            ...json(ok({ $ref: '#/components/schemas/Flags' })),
          },
          ...errors,
          ...notFound,
        },
      },
    },
    '/v1/recalls': {
      get: {
        operationId: 'listRecalls',
        summary: 'Recalls by K-number or product code, most recent first',
        parameters: [query('kNumber', { type: 'string', pattern: K }), query('productCode', { type: 'string', pattern: CODE }), ...listParams],
        responses: {
          '200': { description: 'OK', ...json(ok(page('Recall'))) },
          ...errors,
        },
      },
    },
    '/v1/udi/{di}': {
      get: {
        operationId: 'getUdi',
        summary: 'A GUDID device by primary UDI-DI',
        parameters: [pathParam('di', '^[A-Za-z0-9+$/.-]{6,23}$', '00643169007222')],
        responses: {
          '200': {
            description: 'OK',
            ...json(ok({ $ref: '#/components/schemas/UdiDevice' })),
          },
          ...errors,
          ...notFound,
        },
      },
    },
    '/v1/tracked-product-codes': {
      put: {
        operationId: 'putTrackedProductCodes',
        summary: "Replace this client's product codes whose MAUDE counts are followed (scope fda:track)",
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['productCodes'],
            additionalProperties: false,
            properties: { productCodes: { type: 'array', maxItems: 5000, items: { type: 'string', pattern: CODE } } },
          }),
        },
        responses: {
          '200': { description: 'OK', ...json(ok({ type: 'object', properties: { tracked: int, added: int, syncQueued: bool } })) },
          ...errors,
        },
      },
    },
    '/v1/event-counts/{code}': {
      get: {
        operationId: 'getEventCounts',
        summary: 'MAUDE report counts per day (range up to 3,660 days)',
        parameters: [
          pathParam('code', CODE, 'FRN'),
          query('from', { type: 'string', format: 'date' }, true),
          query('to', { type: 'string', format: 'date' }, true),
        ],
        responses: {
          '200': {
            description: 'OK',
            ...json(ok({ $ref: '#/components/schemas/EventCounts' })),
          },
          ...errors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { const: false },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: { code: str, message: str, details: {} },
          },
        },
      },
      Meta: {
        type: 'object',
        properties: {
          dataAsOf: ndate,
          datasets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                dataset: {
                  enum: ['classification', '510k', 'recall', 'udi', 'event_counts'],
                },
                sourceLastUpdated: ndate,
                lastSyncedAt: { type: ['string', 'null'], format: 'date-time' },
                lastRunStatus: {
                  enum: ['running', 'succeeded', 'failed', null],
                },
                records: int,
              },
            },
          },
        },
      },
      Clearance: {
        type: 'object',
        properties: {
          kNumber: str,
          verified: { const: true },
          applicant: nstr,
          deviceName: nstr,
          productCode: nstr,
          deviceClass: nstr,
          regulationNumber: nstr,
          decisionCode: nstr,
          decisionDescription: nstr,
          decisionDate: ndate,
          dateReceived: ndate,
          clearanceType: nstr,
          statementOrSummary: nstr,
          thirdPartyReview: bool,
          fdaUrl: str,
          summaryDocument: {
            description: 'Our cached copy of the public 510(k) summary PDF (F1.2); null until the fetcher has seen this K-number.',
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                properties: {
                  status: { enum: ['queued', 'fetching', 'fetched', 'no_summary', 'failed'] },
                  reason: nstr,
                  sourceUrl: nstr,
                  sha256: nstr,
                  sizeBytes: nint,
                  fetchedAt: { type: ['string', 'null'], format: 'date-time' },
                  checkedAt: { type: ['string', 'null'], format: 'date-time' },
                },
              },
            ],
          },
          dataAsOf: ndate,
        },
      },
      ClearanceSummary: {
        type: 'object',
        properties: {
          kNumber: str,
          applicant: nstr,
          deviceName: nstr,
          productCode: nstr,
          decisionDate: ndate,
          decisionDescription: nstr,
          clearanceType: nstr,
          statementOrSummary: nstr,
        },
      },
      ProductCode: {
        type: 'object',
        properties: {
          productCode: str,
          deviceName: nstr,
          deviceClass: nstr,
          regulationNumber: nstr,
          medicalSpecialty: nstr,
          medicalSpecialtyDescription: nstr,
          reviewPanel: nstr,
          submissionTypeId: nstr,
          implant: bool,
          lifeSustainSupport: bool,
          definition: nstr,
          clearances: {
            type: 'object',
            properties: { total: int, latestDecisionDate: ndate },
          },
          fdaUrl: str,
          dataAsOf: ndate,
          clearancesAsOf: ndate,
        },
      },
      Recall: {
        type: 'object',
        properties: {
          productResNumber: str,
          productCode: nstr,
          kNumbers: strs,
          recallStatus: nstr,
          dateInitiated: ndate,
          datePosted: ndate,
          dateTerminated: ndate,
          recallingFirm: nstr,
          reasonForRecall: nstr,
          fdaUrl: nstr,
        },
      },
      Flags: {
        type: 'object',
        properties: {
          kNumber: str,
          productCode: nstr,
          recalls: {
            type: 'object',
            properties: {
              total: int,
              open: int,
              shown: int,
              items: { type: 'array', items: { type: 'object' } },
              dataAsOf: ndate,
            },
          },
          maude: {
            type: 'object',
            properties: {
              scope: { const: 'product_code' },
              tracked: bool,
              reportsLast12Months: nint,
              reportsInCopy: nint,
              firstReportDate: ndate,
              lastReportDate: ndate,
              note: str,
              dataAsOf: ndate,
            },
          },
        },
      },
      UdiDevice: {
        type: 'object',
        properties: {
          primaryDi: str,
          brandName: nstr,
          versionOrModelNumber: nstr,
          companyName: nstr,
          productCodes: strs,
          premarketSubmissions: strs,
          commercialDistributionStatus: nstr,
          publicVersionDate: ndate,
        },
      },
      EventCounts: {
        type: 'object',
        properties: {
          productCode: str,
          tracked: bool,
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          total: nint,
          days: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string', format: 'date' },
                reports: int,
              },
            },
          },
        },
      },
    },
  },
} as const;

if (require.main === module) {
  const out = join(__dirname, '..', '..', 'openapi.json');
  writeFileSync(out, JSON.stringify(openapi, null, 2) + '\n');
  console.info(`Wrote ${out}`);
}
