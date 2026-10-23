/** What a sign-in provider tells the relay about the person who signed in. */
export interface ProviderIdentity {
  /** Stable provider user id (never the email: emails change and can be reassigned). */
  readonly subject: string;
  readonly email?: string;
  readonly name?: string;
}

export interface Provider {
  readonly id: "github" | "google";
  readonly label: string;
  /** Where to send the browser; `redirectUri` is the relay's own callback. */
  authorizeUrl(p: { readonly state: string; readonly redirectUri: string }): string;
  /** Exchange the callback code for the signed-in identity. Throws on any failure. */
  exchange(p: { readonly code: string; readonly redirectUri: string }): Promise<ProviderIdentity>;
}

export interface ProviderCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: typeof fetch;
}

const TIMEOUT_MS = 10_000;

async function getJson(f: typeof fetch, url: string, init: RequestInit): Promise<any> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

async function exchangeCode(
  f: typeof fetch,
  tokenUrl: string,
  form: Record<string, string>,
): Promise<string> {
  const json = await getJson(f, tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (typeof json?.access_token !== "string") throw new Error(`no access token (${String(json?.error ?? "unknown error")})`);
  return json.access_token;
}

export interface GithubEndpoints {
  readonly authorize: string;
  readonly token: string;
  /** REST API base (`/user`, `/user/emails`). */
  readonly api: string;
}

const GITHUB: GithubEndpoints = {
  authorize: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
  api: "https://api.github.com",
};

export function githubProvider(c: ProviderCredentials & { readonly endpoints?: GithubEndpoints }): Provider {
  const e = c.endpoints ?? GITHUB;
  const f = c.fetch ?? fetch;
  return {
    id: "github",
    label: "GitHub",
    authorizeUrl({ state, redirectUri }) {
      const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: redirectUri, state, scope: "read:user user:email", allow_signup: "true" });
      return `${e.authorize}?${q}`;
    },
    async exchange({ code, redirectUri }) {
      const token = await exchangeCode(f, e.token, { client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirectUri });
      const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "tabcrew-relay" };
      const user = await getJson(f, `${e.api}/user`, { headers });
      if (typeof user?.id !== "number") throw new Error("GitHub returned no user id");
      let email: string | undefined = typeof user.email === "string" ? user.email : undefined;
      if (!email) {
        const emails = await getJson(f, `${e.api}/user/emails`, { headers }).catch(() => []);
        email = Array.isArray(emails) ? emails.find((m: any) => m?.primary && m?.verified)?.email : undefined;
      }
      return { subject: String(user.id), email, name: user.name || user.login };
    },
  };
}

export interface GoogleEndpoints {
  readonly authorize: string;
  readonly token: string;
  readonly userinfo: string;
}

const GOOGLE: GoogleEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
};

export function googleProvider(c: ProviderCredentials & { readonly endpoints?: GoogleEndpoints }): Provider {
  const e = c.endpoints ?? GOOGLE;
  const f = c.fetch ?? fetch;
  return {
    id: "google",
    label: "Google",
    authorizeUrl({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        prompt: "select_account",
      });
      return `${e.authorize}?${q}`;
    },
    async exchange({ code, redirectUri }) {
      const token = await exchangeCode(f, e.token, {
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      const info = await getJson(f, e.userinfo, { headers: { authorization: `Bearer ${token}` } });
      if (typeof info?.sub !== "string") throw new Error("Google returned no subject");
      return { subject: info.sub, email: info.email_verified ? info.email : undefined, name: info.name };
    },
  };
}
