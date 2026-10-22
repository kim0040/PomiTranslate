<script lang="ts">
  import Brand from '../components/Brand.svelte';
  import Icon from '../components/Icon.svelte';
  import { t, type MessageKey } from '../lib/i18n/index.svelte';

  import { onMount } from 'svelte';
  import { app } from '../lib/app.svelte';
  import { appVersion } from '../lib/native';
  import { APP_VERSION } from '../lib/version';

  const REPOSITORY_URL = 'https://github.com/kim0040/PomiTranslate';
  // Required wording from the Minecraft Usage Guidelines, shown verbatim in every language.
  const UNOFFICIAL = 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.';
  let version = $state(APP_VERSION);
  onMount(() => { void appVersion(APP_VERSION).then((value) => (version = value)); });
  const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
  const SUPPORT_MATRIX_URL = `${REPOSITORY_URL}/blob/main/docs/support-matrix.md`;
  const EULA_URL = 'https://www.minecraft.net/en-us/eula';
  const USAGE_GUIDELINES_URL = 'https://www.minecraft.net/en-us/usage-guidelines';

  const verifiedScopes: MessageKey[] = [
    'coverage.regions',
    'coverage.entities',
    'coverage.resource_pack'
  ];

  const notScannedScopes: MessageKey[] = [
    'coverage.datapacks',
    'coverage.command_storage',
    'coverage.playerdata'
  ];

  const blockedFormatKeys: MessageKey[] = [
    'world.blocked.bedrock',
    'world.blocked.mcr',
    'world.blocked.linear'
  ];

  const verifiedCompression = ['gzip', 'zlib', 'uncompressed', 'LZ4Block', 'external .mcc'];

  type Diagnostics = {
    platform: string;
    renderer: string;
    storage: string;
  };

  function detectPlatform(): string {
    if (typeof navigator === 'undefined') return t('about.unavailable');
    const userAgent = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iOS';
    if (/Android/i.test(userAgent)) return 'Android';
    if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macOS';
    if (/Windows/i.test(userAgent)) return 'Windows';
    if (/Linux/i.test(userAgent)) return 'Linux';
    return navigator.platform || t('about.unavailable');
  }

  function detectRenderer(): string {
    if (typeof navigator === 'undefined') return t('about.unavailable');
    const userAgent = navigator.userAgent;
    if (/Edg\//i.test(userAgent)) return 'Chromium / WebView2';
    if (/Chrome|Chromium/i.test(userAgent)) return 'Chromium';
    if (/Firefox/i.test(userAgent)) return 'Gecko';
    if (/AppleWebKit/i.test(userAgent)) return 'WebKit';
    return 'WebView';
  }

  function detectStorage(): string {
    if (typeof localStorage === 'undefined') return t('about.unavailable');
    try {
      return localStorage ? t('about.available') : t('about.unavailable');
    } catch {
      return t('about.unavailable');
    }
  }

  const diagnostics: Diagnostics = $derived.by(() => ({
    platform: detectPlatform(),
    renderer: detectRenderer(),
    storage: detectStorage()
  }));
</script>

<div class="page about">
  <!-- The one heading of the page is the product name; its text is the lockup, named for assistive tech. -->
  <header class="hero card">
    <img class="mascot" src="/images/pomi.png" alt="" width="96" height="96" />
    <h1 aria-label={t('about.title')}><Brand height={36} /></h1>
    <p class="meta"><span>{t('app.tagline')}</span><span aria-hidden="true">·</span><span>{t('about.version', { version })}</span></p>
    <p class="lead">{t('about.lead')}</p>
  </header>

  <nav class="links" aria-label={t('about.linksLabel')}>
    <a class="link-row" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
      <Icon name="language" size={18} />
      <span><strong>GitHub</strong><small class="mono">kim0040/PomiTranslate</small></span>
      <Icon name="chevron-right" size={16} />
    </a>
    <button type="button" class="link-row" onclick={() => (app.showLicenses = true)}>
      <Icon name="shield" size={18} />
      <span><strong>{t('about.licenses')}</strong><small>{t('about.licensesHint')}</small></span>
      <Icon name="chevron-right" size={16} />
    </button>
    <a class="link-row" href={LICENSE_URL} target="_blank" rel="noreferrer">
      <Icon name="shield" size={18} />
      <span><strong>MIT License</strong><small>LICENSE</small></span>
      <Icon name="chevron-right" size={16} />
    </a>
    <a class="link-row" href="mailto:mini0227kim@gmail.com">
      <Icon name="info" size={18} />
      <span><strong>{t('about.contact')}</strong><small>mini0227kim@gmail.com</small></span>
      <Icon name="chevron-right" size={16} />
    </a>
    <a class="link-row" href={EULA_URL} target="_blank" rel="noreferrer">
      <Icon name="info" size={18} />
      <span><strong>Minecraft EULA</strong><small>minecraft.net</small></span>
      <Icon name="chevron-right" size={16} />
    </a>
    <a class="link-row" href={USAGE_GUIDELINES_URL} target="_blank" rel="noreferrer">
      <Icon name="info" size={18} />
      <span><strong>Usage Guidelines</strong><small>minecraft.net</small></span>
      <Icon name="chevron-right" size={16} />
    </a>
  </nav>

  <div class="sections list">
    <details open>
      <summary>
        <span class="head"><h2>{t('notice.title')}</h2><span class="sum">{t('about.sum.notice')}</span></span>
        <Icon name="chevron-down" size={16} />
      </summary>
      <div class="panel notice">
        <p class="required" lang="en">{UNOFFICIAL}</p>
        <p>{t('about.unofficial')}</p>
        <p>{t('notice.item1')}</p>
        <p>{t('notice.item2')}</p>
      </div>
    </details>

    <details>
      <summary>
        <span class="head"><h2>{t('coverage.title')}</h2><span class="sum">{t('about.sum.scope')}</span></span>
        <Icon name="chevron-down" size={16} />
      </summary>
      <div class="panel">
        <p class="muted">{t('coverage.lead')}</p>

        <div class="coverage-group">
          <h3><span class="pill pill-success"><Icon name="check-circle" size={14} /> {t('coverage.scanned')}</span></h3>
          <ul class="scope-list">
            {#each verifiedScopes as key (key)}
              <li><Icon name="check" size={16} /> <span>{t(key)}</span></li>
            {/each}
          </ul>
        </div>

        <div class="coverage-group">
          <h3><span class="pill pill-accent">{t('about.supportedFormats')}</span></h3>
          <ul class="format-list" aria-label={t('about.supportedFormats')}>
            {#each verifiedCompression as format (format)}
              <li><span class="pill">{format}</span></li>
            {/each}
          </ul>
        </div>

        <div class="coverage-group not-scanned">
          <h3><span class="pill pill-warning"><Icon name="minus" size={14} /> {t('coverage.notScanned')}</span></h3>
          <ul class="scope-list">
            {#each notScannedScopes as key (key)}
              <li><Icon name="minus" size={16} /> <span>{t(key)}</span></li>
            {/each}
          </ul>
        </div>

        <div class="coverage-group blocked">
          <h3><span class="pill pill-danger"><Icon name="alert-triangle" size={14} /> {t('result.unsupported')}</span></h3>
          <ul class="scope-list">
            {#each blockedFormatKeys as key (key)}
              <li><Icon name="alert-triangle" size={16} /> <span>{t(key)}</span></li>
            {/each}
          </ul>
          <p class="hint">{t('about.unsupportedHelp')}</p>
        </div>

        <a class="matrix-link" href={SUPPORT_MATRIX_URL} target="_blank" rel="noreferrer">
          <span>{t('about.supportMatrix')}</span>
          <span class="mono">docs/support-matrix.md</span>
          <Icon name="chevron-right" size={16} />
        </a>
      </div>
    </details>

    <details>
      <summary>
        <span class="head"><h2>{t('about.privacy.title')}</h2><span class="sum">{t('about.sum.privacy')}</span></span>
        <Icon name="chevron-down" size={16} />
      </summary>
      <div class="panel">
        <p>{t('about.local')}</p>
        <p class="keychain-note">{t('settings.vault.help')}</p>
      </div>
    </details>

    <details>
      <summary>
        <span class="head"><h2>{t('about.diagnostics')}</h2><span class="sum">{diagnostics.platform} · {diagnostics.renderer}</span></span>
        <Icon name="chevron-down" size={16} />
      </summary>
      <div class="panel">
        <p class="muted">{t('about.diagnosticsLead')}</p>
        <dl>
          <div><dt>{t('about.platform')}</dt><dd>{diagnostics.platform}</dd></div>
          <div><dt>{t('about.renderer')}</dt><dd>{diagnostics.renderer}</dd></div>
          <div><dt>{t('about.storage')}</dt><dd>{diagnostics.storage}</dd></div>
        </dl>
      </div>
    </details>
  </div>
</div>

<style>
  /* One calm column: the mark, the lockup, what the app is. Nothing repeats the name. */
  .hero { display: grid; justify-items: center; text-align: center; gap: var(--space-3); padding: var(--space-6) var(--space-5); }
  .mascot { width: 96px; height: 96px; object-fit: contain; }
  .hero h1 { display: grid; justify-items: center; margin: 0; }
  .hero h1 :global(.brand) { max-width: 100%; height: auto; }
  .meta { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-2); color: var(--text-secondary); font-size: var(--text-sm); }
  .hero .lead { max-width: 52ch; color: var(--text); }

  .links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
  button.link-row { width: 100%; background: var(--bg-surface); font: inherit; text-align: start; }
  .link-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 48px; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-surface); color: var(--text); text-decoration: none; box-shadow: var(--shadow-card); }
  .link-row:hover { background: var(--bg-hover); border-color: var(--border-strong); }
  .link-row > :global(.icon:first-child) { color: var(--accent-text); }
  .link-row > :global(.icon:last-child) { color: var(--text-secondary); }
  .link-row span { display: grid; gap: 1px; min-width: 0; }
  .link-row strong { font-size: var(--text-sm); }
  .link-row small { overflow-wrap: anywhere; color: var(--text-secondary); font-size: var(--text-xs); }

  .sections { background: var(--bg-surface); }
  .sections > details + details { border-top: 1px solid var(--border); }
  summary { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 56px; padding: var(--space-3) var(--space-4); list-style: none; cursor: pointer; }
  summary::-webkit-details-marker { display: none; }
  summary:focus-visible { outline-offset: -2px; }
  summary > :global(.icon) { flex: none; color: var(--text-secondary); transition: rotate var(--dur-base) var(--ease-out); }
  details[open] > summary > :global(.icon) { rotate: 180deg; }
  @media (hover: hover) { summary:hover { background: var(--bg-hover); } }
  .head { display: grid; gap: 2px; min-width: 0; }
  .head h2 { font-size: var(--text-lg); font-weight: 600; }
  details[open] .sum { display: none; }
  .sum { color: var(--text-secondary); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .panel { display: grid; gap: var(--space-3); padding: 0 var(--space-4) var(--space-4); color: var(--text-secondary); font-size: var(--text-sm); }
  .panel > p { max-width: 80ch; }
  .required { font-weight: 700; color: var(--text); letter-spacing: 0.01em; }

  .coverage-group { display: grid; gap: var(--space-2); margin-top: var(--space-2); }
  .coverage-group h3 { font-size: var(--text-sm); }
  .scope-list, .format-list { list-style: none; display: grid; gap: var(--space-2); margin: 0; padding: 0; }
  .scope-list li { display: flex; align-items: flex-start; gap: var(--space-2); color: var(--text-secondary); font-size: var(--text-sm); }
  .scope-list :global(.icon) { color: var(--success-solid); margin-top: 2px; flex: none; }
  .not-scanned .scope-list :global(.icon) { color: var(--warning-solid); }
  .blocked .scope-list :global(.icon) { color: var(--danger-solid); }
  .format-list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .format-list .pill { font-family: var(--font-mono); font-weight: 500; }
  .matrix-link { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--border); color: var(--accent-text); font-weight: 600; text-decoration: none; }
  .matrix-link:hover { text-decoration: underline; }
  .matrix-link .mono { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: var(--text-xs); font-weight: 400; }
  .matrix-link :global(.icon:last-child) { margin-inline-start: auto; flex: none; }
  .keychain-note { padding: var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); color: var(--text-secondary); font-size: var(--text-sm); }
  dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin: 0; }
  dl > div { min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-sunken); }
  dt { color: var(--text-secondary); font-size: var(--text-xs); font-weight: 600; }
  dd { margin: var(--space-1) 0 0; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: var(--text-sm); color: var(--text); }

  @media (max-width: 760px) {
    .links { grid-template-columns: 1fr; }
    dl { grid-template-columns: 1fr; }
  }
  @media (max-width: 400px) {
    .hero { padding: var(--space-5) var(--space-4); }
  }
</style>
