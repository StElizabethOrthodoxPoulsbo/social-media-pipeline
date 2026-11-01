# First-time setup

This is a one-time job for whoever looks after the parish's GitHub account,
and takes about an hour. Editors never need to do any of it.

## 1. Parish settings

Edit [`config/pipeline.yml`](../config/pipeline.yml):

- `parish.name` and `parish.hashtags`.
- `timezone` (an IANA name such as `America/New_York`). **Also change
  `input_timezone`** in [`site/admin/config.yml`](../site/admin/config.yml) to match.
- `calendar.source`: `gregorian` (New Calendar) or `julian` (Old Calendar).
- `calendar.include_sundays`, `min_feast_level`, `default_post_time` and
  `default_channels`.

If you fork or rename the repository, update `repo`, `site_url` and
`display_url` in `site/admin/config.yml` and `site_url` in `config/pipeline.yml`.

## 2. GitHub Pages

The editor, and the images Buffer downloads, are served from GitHub Pages.

1. Go to [**Settings → Pages**](https://github.com/StElizabethOrthodoxPoulsbo/social-media-pipeline/settings/pages)
   and set **Source** to **GitHub Actions**.
2. Pages on a private repository needs a paid GitHub plan. On the free plan the
   repository must be public. Either way, files in `site/uploads/` are public.

## 3. Editor sign-in

Every editor needs a (free) GitHub account with **write** access to this
repository. They do **not** need to be members of the StElizabethOrthodoxPoulsbo
organization. See [Adding editors](#adding-editors) below.

> **Sign In with GitHub does not work until you complete option A.** GitHub
> Pages cannot run the OAuth exchange itself, so the button needs a small
> external service. Until then, use **Sign In with Token** (option B).

### Option A (recommended): Sveltia CMS Authenticator

This is a free Cloudflare Worker that handles the GitHub OAuth exchange. Set it
up once, and editors then just click **Sign In with GitHub**.

1. **Deploy the worker.** Create a free [Cloudflare](https://dash.cloudflare.com/sign-up)
   account, then use the **Deploy to Cloudflare Workers** button on
   <https://github.com/sveltia/sveltia-cms-auth>. Copy the worker URL, e.g.
   `https://sveltia-cms-auth.<subdomain>.workers.dev`.
   Make sure you deploy **sveltia-cms-auth**, not this repository. A worker
   built from this repository just serves the landing page and returns 404 for
   `/auth` and `/callback`. If Cloudflare is connected to this repository, it
   also adds a failing "Workers Builds" check to every pull request; delete
   that worker.
2. **Register a GitHub OAuth app.** An org owner opens
   [**New OAuth App** for StElizabethOrthodoxPoulsbo](https://github.com/organizations/StElizabethOrthodoxPoulsbo/settings/applications/new)
   (**StElizabethOrthodoxPoulsbo → Settings → Developer settings → OAuth Apps → New OAuth App**).
   An org-owned app survives staff changes. Fill in:
   - Application name: `Parish Social Media Editor`
   - Homepage URL: `https://stelizabethorthodoxpoulsbo.github.io/social-media-pipeline/`
   - Authorization callback URL: `<worker URL>/callback`, e.g.
     `https://sveltia-cms-auth.<subdomain>.workers.dev/callback`
   - Leave **Enable Device Flow** unchecked.

   Then click **Generate a new client secret**. **Copy it immediately** with the
   copy icon. GitHub only shows it once. Also copy the Client ID.

   OAuth apps can't be created through the API or `gh`; this step must be done
   in the browser.
3. **Configure the worker.** In Cloudflare, open **Workers & Pages →
   sveltia-cms-auth → Settings**. Under **Variables and Secrets** (the runtime
   section near the top, **not** the **Build** section further down), click
   **+ Add** for each:
   - `GITHUB_CLIENT_ID`: the Client ID
   - `GITHUB_CLIENT_SECRET`: the client secret (type **Secret**)
   - `ALLOWED_DOMAINS`: `stelizabethorthodoxpoulsbo.github.io`

   Click **Deploy** in that dialog to apply them.

   To check the worker, open
   `<worker URL>/auth?provider=github&site_id=stelizabethorthodoxpoulsbo.github.io`. It
   should redirect to a GitHub sign-in page. If it shows
   `MISCONFIGURED_CLIENT`, the variables aren't in the runtime section.
4. **Point the editor at it.** In `site/admin/config.yml`, set `base_url`
   under `backend` to the worker URL (no trailing slash), and commit.
   The publish workflow redeploys the site.
   This repository already configures
   `https://sveltia-cms-auth.darthtrevino.workers.dev`; the worker's runtime OAuth
   secrets and allowed domain must still be verified externally. A configured
   URL alone does not prove sign-in works for the new Pages domain.
5. If the organization restricts third-party OAuth apps
   ([**Settings → Third-party access**](https://github.com/organizations/StElizabethOrthodoxPoulsbo/settings/oauth_application_policy)),
   approve the app. Otherwise editors will sign in successfully but won't see
   the repository.

When editors sign in for the first time, GitHub asks them to authorize
"Parish Social Media Editor" with the `repo` scope. GitHub words this as "full
control of private repositories". That's how classic OAuth apps work. In
practice the editor only uses the repositories the person can already access.

#### Troubleshooting sign-in

| Error | Fix |
| --- | --- |
| `incorrect_client_credentials` | The secret in Cloudflare doesn't match the OAuth app. On the app page, the secret is usually marked **Never used**. Generate a new client secret, paste it into `GITHUB_CLIENT_SECRET` (no spaces), deploy, and try again. Then delete the old secret. |
| `MISCONFIGURED_CLIENT` | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are missing from the worker's runtime **Variables and Secrets**. |
| `UNSUPPORTED_DOMAIN` | `ALLOWED_DOMAINS` doesn't include `stelizabethorthodoxpoulsbo.github.io`. |
| `redirect_uri` mismatch, or a 404 after GitHub approval | The OAuth app's callback URL isn't `<worker URL>/callback`. |
| Signed in but no posts / can't save | The person lacks write access to the repo, or the org hasn't approved the OAuth app. |

### Option B (quick start): personal access token

Each editor creates a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):

- Resource owner: **StElizabethOrthodoxPoulsbo**
- Repository access: **Only select repositories → social-media-pipeline**
- Repository permissions: **Contents: Read and write**

Then they click **Sign In with Token** in the editor and paste it. If the
organization requires approval for fine-grained tokens, an org owner must
approve each one (**Settings → Personal access tokens → Pending requests**).

### Adding editors

Choose one:

- **Outside collaborator (simplest for volunteers):** open
  [**Settings → Collaborators and teams**](https://github.com/StElizabethOrthodoxPoulsbo/social-media-pipeline/settings/access),
  click **Add people**, enter their GitHub username or email, and choose
  **Write**. They see only this repository, and it's free for public and
  private repositories.
- **Organization member in a team:** invite them to StElizabethOrthodoxPoulsbo and add them
  to a team with **Write** on this repository. This is easier to manage if the
  team grows.

They must accept the emailed invitation before they can sign in to the editor.

> **Branch protection:** the editor commits directly to `main`. If you protect
> `main` with required reviews, editors cannot save. Use the post statuses for
> review instead.

## 4. Buffer

1. Create a [Buffer](https://buffer.com) account. **Ideas exports do not require
   any connected social accounts.** Only normal social scheduling needs the
   parish **Facebook Page** and **Instagram Business/Creator account** connected.
2. Create an API key at <https://publish.buffer.com/settings/api>.
3. Add it as a repository secret named **`BUFFER_API_KEY`**:
   [**New repository secret**](https://github.com/StElizabethOrthodoxPoulsbo/social-media-pipeline/settings/secrets/actions/new)
   (**Settings → Secrets and variables → Actions**).
4. Find your organization and (for social scheduling) channel IDs:

   ```sh
   npm ci
   BUFFER_API_KEY=... npm run buffer:channels
   ```

   Put channel IDs in `buffer.channels` only when connecting social accounts.
   Ideas auto-select the key's **sole** accessible organization. If there are
   zero or multiple organizations, export stops with a readable message instead
   of guessing; set `buffer.organization_id` to the intended accessible ID.
   Do not put the API key in configuration, posts, screenshots or logs.
5. Free-plan limits are about 10 queued posts per channel and 100 API
   requests per 15 minutes. Posts are only sent to Buffer
   `schedule_window_days` (default 14) before publishing. On a paid plan you can
   raise that.

Until `BUFFER_API_KEY` is set, the publish workflow runs in preview mode and
only logs what it would do.

### Ideas-only demo

After this implementation lands on `main` and Pages redeploys:

1. Verify editor access (GitHub write permission and the worker's
   `ALLOWED_DOMAINS`/OAuth configuration, or a token login).
2. Create **one specific demo post**, keep it **Draft**, write a finished caption
   and optionally upload an image. Set its date for tomorrow as a planning date.
3. Turn on **Send to Buffer Ideas** and save. Do not approve it, and do not
   opt existing posts into a bulk export.
4. Watch **Publish site & sync Buffer**; reload the CMS to see its export result
   and returned Idea ID, then verify the content in Buffer's **Create / Ideas**.
   With no channel IDs configured, Ideas still work.

The workflow uses the existing `BUFFER_API_KEY` and can commit state directly
to `main`. Keep direct status/checkpoint commits permitted; required-review
rules that block the workflow also block Ideas creation. Local live Ideas
exports are intentionally refused: only the main workflow with
`--checkpoint-ideas` can push the durable pre-creation ledger. `--dry-run`
previews without mutations or persistent state; its organization is simulated.

**Ambiguous creation recovery:** inspect Buffer's Ideas board before touching
state. If the attempt created an Idea, record its actual ID and `status:
exported` in the existing `state/buffer.json` Ideas entry (retain its key,
organization and hash). If you have verified that no Idea was created, set that
entry's status to `error` to permit a new attempt. Keep the CMS export key.
Do not clear pending state or recreate content merely because a request timed
out. No public Idea update/delete or idempotency-key API is available; manage
edits/removals manually in Buffer. Canceled/deleted CMS posts retain the ledger,
and archived posts also preserve the Idea evidence.
Filename history also guards against stale CMS saves that lose generated fields.
Do not reuse an exported post's old filename for a different new Idea; choose a
new title/slug instead.

## 5. Feast-day drafts (agentic workflow)

The weekly [`hydrate-feast-calendar`](../.github/workflows/hydrate-feast-calendar.md)
workflow uses [GitHub Agentic Workflows](https://github.github.com/gh-aw/) with
the Copilot engine.

The workflow runs weekly, on Monday at 03:21 UTC (Sunday evening in the
Americas). It looks `calendar.lookahead_days` (90) ahead and only drafts days
that have no post yet, including canceled ones. If nothing is new, it stops
before the AI step and costs nothing. To change the schedule, edit `on:
schedule:` in the `.md` file and recompile.

1. Create the **`COPILOT_GITHUB_TOKEN`** secret. The person creating it needs
   a GitHub Copilot license (Free, Pro or Business); the workflow's AI usage
   counts against it.
   1. Open this
      [pre-filled token page](https://github.com/settings/personal-access-tokens/new?name=COPILOT_GITHUB_TOKEN&description=GitHub+Agentic+Workflows+-+Copilot+engine+authentication&user_copilot_requests=read).
   2. Set **Resource owner** to **your user account**, not the organization.
   3. Leave repository access as **Public repositories** (no repository
      permissions are needed).
   4. Under **Account permissions**, check that **Copilot Requests** is **Read**.
   5. Set an expiration you can remember to renew, then click **Generate token**.
   6. Open [**New repository secret**](https://github.com/StElizabethOrthodoxPoulsbo/social-media-pipeline/settings/secrets/actions/new)
      (**Settings → Secrets and variables → Actions**). Name it
      `COPILOT_GITHUB_TOKEN` and paste the token. (Or run
      `gh aw secrets set COPILOT_GITHUB_TOKEN --value "<token>"`.)

   If the organization has centralized Copilot billing, you can skip the token.
   Add `copilot-requests: write` under `permissions:` in
   `.github/workflows/hydrate-feast-calendar.md` and recompile. See the
   [gh-aw authentication docs](https://github.github.com/gh-aw/reference/auth/).
2. Allow GitHub Actions to create pull requests: open
   [**Settings → Actions → General**](https://github.com/StElizabethOrthodoxPoulsbo/social-media-pipeline/settings/actions),
   and under **Workflow permissions** tick **Allow GitHub Actions to create and
   approve pull requests**.
3. Create the `feast-calendar` and `automation` labels on the
   [**Labels**](https://github.com/StElizabethOrthodoxPoulsbo/social-media-pipeline/labels)
   page, or remove them from the workflow.
4. Run it once from the [**Actions**](https://github.com/StElizabethOrthodoxPoulsbo/social-media-pipeline/actions)
   tab (**Draft feast-day posts → Run workflow**).
   It opens a PR with drafts for the next 90 days. After you merge it, the
   drafts appear in the editor.

After editing the workflow's `.md` file, recompile with
`gh extension install github/gh-aw && gh aw compile` and commit the `.lock.yml`.

## 6. Check it works

1. Open <https://stelizabethorthodoxpoulsbo.github.io/social-media-pipeline/admin/> and sign in.
2. Create a test post a few days ahead with an image. Set it to **Approved** and save.
3. Watch **Actions → Publish site & sync Buffer**. The post should appear in
   Buffer and its status should change to **Scheduled** (reload the editor).
4. Edit the caption, save, and check that Buffer updates. Set it to **Canceled**
   and check that it disappears from Buffer.

You can run the publish workflow manually with **dry run** ticked to preview
changes without touching Buffer.
