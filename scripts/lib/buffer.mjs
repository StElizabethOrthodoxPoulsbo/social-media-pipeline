// Minimal client for Buffer's GraphQL API (https://developers.buffer.com).

export const BUFFER_ENDPOINT = 'https://api.buffer.com';

export class BufferError extends Error {
  constructor(message, { code, retryable = false } = {}) {
    super(message);
    this.name = 'BufferError';
    this.code = code;
    this.retryable = retryable;
  }
}

const POST_FIELDS = 'id status dueAt externalLink error { message }';

const CREATE_POST = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { ${POST_FIELDS} } }
    ... on MutationError { message }
  }
}`;

const EDIT_POST = `mutation EditPost($input: EditPostInput!) {
  editPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { ${POST_FIELDS} } }
    ... on MutationError { message }
  }
}`;

const DELETE_POST = `mutation DeletePost($input: DeletePostInput!) {
  deletePost(input: $input) {
    __typename
    ... on DeletePostSuccess { id }
    ... on MutationError { message }
  }
}`;

const GET_POST = `query GetPost($input: PostInput!) {
  post(input: $input) { ${POST_FIELDS} }
}`;

const GET_ORGANIZATIONS = `query { account { organizations { id name } } }`;

const CREATE_IDEA = `mutation CreateIdea($input: CreateIdeaInput!) {
  createIdea(input: $input) {
    __typename
    ... on Idea { id }
    ... on IdeaResponse { idea { id } }
    ... on MutationError { message }
  }
}`;

const GET_CHANNELS = `query GetChannels($input: ChannelsInput!) {
  channels(input: $input) { id name displayName service }
}`;

export class BufferClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch, endpoint = BUFFER_ENDPOINT, maxRetries = 3 }) {
    if (!apiKey) throw new Error('BUFFER_API_KEY is not set');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.endpoint = endpoint;
    this.maxRetries = maxRetries;
    this.requests = 0;
  }

  async request(query, variables = {}, { retries = this.maxRetries } = {}) {
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      const res = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ query, variables }),
      });
      let payload;
      try {
        payload = await res.json();
      } catch {
        payload = { errors: [{ message: `HTTP ${res.status} from Buffer`, extensions: { code: 'UNEXPECTED' } }] };
      }
      const error = payload.errors?.[0];
      const code = error?.extensions?.code ?? (res.status === 429 ? 'RATE_LIMIT_EXCEEDED' : undefined);
      if (!error && res.ok) return payload.data;

      const retryable = code === 'UNEXPECTED' || res.status >= 500;
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new BufferError(error?.message ?? `HTTP ${res.status} from Buffer`, {
        code,
        retryable: retryable || code === 'RATE_LIMIT_EXCEEDED',
      });
    }
  }

  static unwrap(result, action) {
    if (result?.post) return result.post;
    if (result?.id) return result;
    throw new BufferError(`${action} failed: ${result?.message ?? 'unknown error'}`, {
      code: result?.__typename === 'NotFoundError' ? 'NOT_FOUND' : 'MUTATION_ERROR',
    });
  }

  async createPost(input) {
    const data = await this.request(CREATE_POST, { input });
    return BufferClient.unwrap(data.createPost, 'createPost');
  }

  async editPost(input) {
    const data = await this.request(EDIT_POST, { input });
    return BufferClient.unwrap(data.editPost, 'editPost');
  }

  async deletePost(id) {
    const data = await this.request(DELETE_POST, { input: { id } });
    return BufferClient.unwrap(data.deletePost, 'deletePost');
  }

  async getPost(id) {
    const data = await this.request(GET_POST, { input: { id } });
    return data.post;
  }

  async organizations() {
    const data = await this.request(GET_ORGANIZATIONS);
    return data.account.organizations;
  }

  async createIdea(input) {
    // No idempotency key is supported: never replay an ambiguous creation.
    const data = await this.request(CREATE_IDEA, { input }, { retries: 0 });
    const result = data?.createIdea;
    const id = result?.__typename === 'Idea' ? result.id
      : result?.__typename === 'IdeaResponse' ? result.idea?.id : undefined;
    if (id) return { id };
    const err = new BufferError(`createIdea failed: ${result?.message ?? 'no Idea ID returned'}`, {
      code: result?.__typename === 'UnauthorizedError' ? 'UNAUTHORIZED' : 'MUTATION_ERROR',
    });
    err.definiteRejection = ['InvalidInputError', 'UnauthorizedError', 'LimitReachedError'].includes(result?.__typename);
    throw err;
  }

  async channels(organizationId) {
    const data = await this.request(GET_CHANNELS, { input: { organizationId } });
    return data.channels;
  }
}
