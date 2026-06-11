/**
 * Secrets detection ruleset.
 *
 * High-signal vendor patterns are adapted from the gitleaks ruleset
 * (MIT, https://github.com/gitleaks/gitleaks); generic keyword-proximity
 * rules catch unprefixed passwords/tokens with placeholder and entropy
 * guards to limit false positives.
 *
 * All patterns require the `g` and `d` flags (`d` so group offsets are
 * available when `secretGroup` targets a capture group).
 */

export interface SecretsRule {
  id: string;
  description: string;
  pattern: RegExp;
  /**
   * Capture group holding the secret; the rest of the match is preserved.
   * Defaults to the whole match.
   */
  secretGroup?: number;
  /**
   * Lowercase substrings; the rule only runs when at least one is present
   * in the lowercased input (cheap prefilter for the polling hot path).
   */
  keywords: string[];
  /** Minimum Shannon entropy (bits/char) required of the secret. */
  minEntropyBitsPerChar?: number;
  /** Skip obvious placeholder values (`<password>`, `${VAR}`, `changeme`…). */
  skipPlaceholders?: boolean;
  /**
   * Require at least one digit or `+/=` in the secret; filters
   * identifier-like values (`access_token_response_field`) that pass
   * entropy checks but are clearly source code, not credentials.
   */
  requireDigitOrSymbol?: boolean;
}

export const SECRETS_RULES: SecretsRule[] = [
  // --- vendor-prefixed tokens (near-zero false-positive risk) ---
  {
    id: "aws-access-key-id",
    description: "AWS access key ID",
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/gd,
    keywords: ["akia", "asia", "abia", "acca"],
  },
  {
    id: "aws-secret-access-key",
    description: "AWS secret access key in assignment context",
    pattern:
      /(?:aws|secret)[\w.-]{0,24}["':=\s]{1,4}["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gid,
    secretGroup: 1,
    keywords: ["aws", "secret"],
    minEntropyBitsPerChar: 3.5,
  },
  {
    id: "github-pat",
    description: "GitHub personal access token (classic)",
    pattern: /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/gd,
    keywords: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
  },
  {
    id: "github-fine-grained-pat",
    description: "GitHub fine-grained personal access token",
    pattern: /\b(github_pat_[A-Za-z0-9_]{82})\b/gd,
    keywords: ["github_pat_"],
  },
  {
    id: "gitlab-pat",
    description: "GitLab personal access token",
    pattern: /\b(glpat-[A-Za-z0-9_-]{20})\b/gd,
    keywords: ["glpat-"],
  },
  {
    id: "slack-token",
    description: "Slack bot/app/personal/refresh token",
    pattern: /\b(xox[baeprs]-[0-9A-Za-z-]{10,250})\b/gd,
    keywords: ["xoxb-", "xoxa-", "xoxe-", "xoxp-", "xoxr-", "xoxs-"],
  },
  {
    id: "slack-webhook-url",
    description: "Slack incoming webhook URL",
    pattern:
      /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+)/gd,
    keywords: ["hooks.slack.com"],
  },
  {
    id: "stripe-api-key",
    description: "Stripe secret/restricted API key",
    pattern: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,99})\b/gd,
    keywords: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"],
  },
  {
    id: "openai-api-key",
    description: "OpenAI API key",
    pattern:
      /\b(sk-[A-Za-z0-9_-]*T3BlbkFJ[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9]{48})\b/gd,
    keywords: ["sk-"],
  },
  {
    id: "anthropic-api-key",
    description: "Anthropic API key",
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{24,})\b/gd,
    keywords: ["sk-ant-"],
  },
  {
    id: "google-api-key",
    description: "Google API key",
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/gd,
    keywords: ["aiza"],
  },
  {
    id: "npm-access-token",
    description: "npm access token",
    pattern: /\b(npm_[A-Za-z0-9]{36})\b/gd,
    keywords: ["npm_"],
  },
  {
    id: "pypi-upload-token",
    description: "PyPI upload token",
    pattern: /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,1000})\b/gd,
    keywords: ["pypi-"],
  },
  {
    id: "sendgrid-api-token",
    description: "SendGrid API token",
    pattern: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/gd,
    keywords: ["sg."],
  },
  {
    id: "telegram-bot-token",
    description: "Telegram bot token",
    pattern: /\b([0-9]{8,10}:AA[A-Za-z0-9_-]{33})\b/gd,
    keywords: [":aa"],
  },
  {
    id: "shopify-token",
    description: "Shopify access token",
    pattern: /\b(shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32})\b/gd,
    keywords: ["shpat_", "shpca_", "shppa_", "shpss_"],
  },
  {
    id: "databricks-pat",
    description: "Databricks personal access token",
    pattern: /\b(dapi[a-f0-9]{32})\b/gd,
    keywords: ["dapi"],
  },
  {
    id: "huggingface-token",
    description: "Hugging Face access token",
    pattern: /\b(hf_[A-Za-z0-9]{34,40})\b/gd,
    keywords: ["hf_"],
  },
  {
    id: "digitalocean-pat",
    description: "DigitalOcean personal access token",
    pattern: /\b(dop_v1_[a-f0-9]{64})\b/gd,
    keywords: ["dop_v1_"],
  },
  {
    id: "azure-storage-account-key",
    description: "Azure storage account key in connection string",
    pattern: /AccountKey=([A-Za-z0-9+/=]{88})/gd,
    secretGroup: 1,
    keywords: ["accountkey="],
  },
  // --- structural secrets ---
  {
    id: "private-key",
    description: "PEM private key block",
    pattern:
      /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----)/gd,
    keywords: ["private key"],
  },
  {
    id: "jwt",
    description: "JSON Web Token",
    pattern:
      /\b(ey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{10,})\b/gd,
    keywords: ["eyj"],
  },
  // --- generic keyword-proximity rules ---
  {
    id: "url-credentials",
    description: "Password embedded in a URL authority section",
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]{1,64}:([^/\s:@'"]{4,256})@/gid,
    secretGroup: 1,
    keywords: ["://"],
    skipPlaceholders: true,
  },
  {
    id: "authorization-bearer",
    description: "Bearer token in an Authorization header",
    pattern: /\bbearer\s+([A-Za-z0-9_~+/.=-]{20,512})\b/gid,
    secretGroup: 1,
    keywords: ["bearer"],
    minEntropyBitsPerChar: 3.0,
  },
  {
    id: "generic-password-assignment",
    description: "Password-like keyword assignment",
    // no leading \b: must also match prefixed names like DB_PASSWORD=
    pattern:
      /(?:password|passwd|pwd|passphrase)\s*[:=]+\s*["']?([^\s"',;]{6,128})/gid,
    secretGroup: 1,
    keywords: ["password", "passwd", "pwd", "passphrase"],
    skipPlaceholders: true,
  },
  {
    id: "generic-api-key-assignment",
    description: "API-key/secret/token-like keyword assignment",
    // no leading \b: must also match prefixed names like STRIPE_API_KEY=
    pattern:
      /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token)\b\s*[:=]+\s*["']?([A-Za-z0-9_+/=.-]{16,256})(?![A-Za-z0-9_+/=.-])/gid,
    secretGroup: 1,
    keywords: ["key", "token", "secret"],
    minEntropyBitsPerChar: 3.0,
    skipPlaceholders: true,
    requireDigitOrSymbol: true,
  },
];
