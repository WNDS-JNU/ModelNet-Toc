export interface OIDCTokenResponseMetadata {
  contentType: string;
  fields: string[];
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  status: number;
}

export type OIDCTokenResponse =
  | {
      accessToken: string;
      expiresIn?: number;
      metadata: OIDCTokenResponseMetadata;
      refreshToken: string;
      success: true;
    }
  | {
      error: string;
      metadata: OIDCTokenResponseMetadata;
      success: false;
    };

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const getNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const getMetadata = (
  response: Response,
  payload: Record<string, unknown>,
): OIDCTokenResponseMetadata => ({
  contentType: response.headers?.get('content-type') || 'unknown',
  fields: Object.keys(payload).sort(),
  hasAccessToken: Boolean(getNonEmptyString(payload.access_token)),
  hasRefreshToken: Boolean(getNonEmptyString(payload.refresh_token)),
  status: response.status,
});

/**
 * Parse an OAuth token response without ever returning token values in diagnostics.
 */
export const parseOIDCTokenResponse = async (
  response: Response,
  operation: string,
): Promise<OIDCTokenResponse> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      error: `${operation}: token response is not valid JSON`,
      metadata: getMetadata(response, {}),
      success: false,
    };
  }

  const payload = asObject(body);
  const metadata = getMetadata(response, payload);
  const oauthError = getNonEmptyString(payload.error);
  const oauthErrorDescription = getNonEmptyString(payload.error_description);

  if (!response.ok || oauthError) {
    const status = [String(response.status), response.statusText].filter(Boolean).join(' ');
    const detail = [oauthError, oauthErrorDescription].filter(Boolean).join(': ');

    return {
      error: [operation, status, detail].filter(Boolean).join(': '),
      metadata,
      success: false,
    };
  }

  const accessToken = getNonEmptyString(payload.access_token);
  const refreshToken = getNonEmptyString(payload.refresh_token);
  const missing = [
    ...(accessToken ? [] : ['access_token']),
    ...(refreshToken ? [] : ['refresh_token']),
  ];

  if (missing.length > 0) {
    return {
      error: `Invalid token response: missing ${missing.join(' and ')}`,
      metadata,
      success: false,
    };
  }

  return {
    accessToken,
    expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
    metadata,
    refreshToken,
    success: true,
  };
};
