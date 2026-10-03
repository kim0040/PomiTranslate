<script lang="ts">
  import Callout from '../components/Callout.svelte';
  import Icon from '../components/Icon.svelte';
  import { t } from '../lib/i18n/index.svelte';

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
  <header class="page-head">
    <h1>{t('about.title')}</h1>
  </header>

  <section class="hero card" aria-labelledby="identity-title">
    <div class="identity">
      <img class="mascot" src="/images/pomi.png" alt="Pomi" width="96" height="96" />
      <div class="identity-copy">
        <img class="wordmark" src="/images/wordmark.png" alt="PomiTranslate" width="220" height="64" />
        <span class="dark-wordmark" role="img" aria-label="PomiTranslate">Pomi<span>Translate</span></span>
        <h2 id="identity-title">{t('app.tagline')}</h2>
        <p class="muted">{t('about.version', { version })}</p>
      </div>
    </div>
    <p class="hero-copy">{t('about.lead')}</p>
  </section>

  <div class="columns">
    <section class="card card-pad" aria-labelledby="coverage-title">
      <div class="section-heading">
        <div>
          <h2 id="coverage-title">{t('coverage.title')}</h2>
          <p class="muted">{t('coverage.lead')}</p>
        </div>
      </div>

      <div class="coverage-group">
        <h3>{t('about.scopeTitle')}</h3>
        <p class="muted">{t('about.scopeSummary')}</p>
      </div>

      <div class="coverage-group">
        <h3>{t('about.supportedFormats')}</h3>
        <ul class="format-list" aria-label={t('about.supportedFormats')}>
          {#each verifiedCompression as format (format)}
            <li><span class="pill">{format}</span></li>
          {/each}
        </ul>
      </div>

      <a class="matrix-link" href={SUPPORT_MATRIX_URL} target="_blank" rel="noreferrer">
        <span>{t('about.supportMatrix')}</span>
        <Icon name="chevron-right" size={17} />
      </a>
    </section>

    <div class="side-stack">
      <Callout tone="warning" title={t('notice.title')}>
        <p class="required" lang="en">{UNOFFICIAL}</p>
        <p>{t('about.unofficial')}</p>
        <p>{t('notice.item1')}</p>
        <p>{t('notice.item2')}</p>
      </Callout>

      <section class="card card-pad" aria-labelledby="privacy-title">
        <div class="section-heading">
          <div>
            <h2 id="privacy-title">{t('settings.apiKey.label')}</h2>
            <p class="muted">{t('about.local')}</p>
          </div>
          <Icon name="shield" size={24} />
        </div>
        <p class="keychain-note">{t('settings.vault.help')}</p>
      </section>

      <section class="card card-pad" aria-labelledby="links-title">
        <h2 id="links-title">{t('about.source')}</h2>
        <nav class="link-list" aria-label={t('about.source')}>
          <a class="link-row" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
            <Icon name="language" size={19} />
            <span><strong>GitHub</strong><small class="mono">kim0040/PomiTranslate</small></span>
            <Icon name="chevron-right" size={17} />
          </a>
          <button type="button" class="link-row" onclick={() => (app.showLicenses = true)}>
            <Icon name="shield" size={19} />
            <span><strong>{t('about.licenses')}</strong><small>{t('about.licensesHint')}</small></span>
            <Icon name="chevron-right" size={17} />
          </button>
          <a class="link-row" href={LICENSE_URL} target="_blank" rel="noreferrer">
            <Icon name="shield" size={19} />
            <span><strong>MIT License</strong><small>LICENSE</small></span>
            <Icon name="chevron-right" size={17} />
          </a>
          <a class="link-row" href="mailto:mini0227kim@gmail.com">
            <Icon name="info" size={19} />
            <span><strong>{t('about.contact')}</strong><small>mini0227kim@gmail.com</small></span>
            <Icon name="chevron-right" size={17} />
          </a>
          <a class="link-row" href={EULA_URL} target="_blank" rel="noreferrer">
            <Icon name="info" size={19} />
            <span><strong>Minecraft EULA</strong><small>minecraft.net</small></span>
            <Icon name="chevron-right" size={17} />
          </a>
          <a class="link-row" href={USAGE_GUIDELINES_URL} target="_blank" rel="noreferrer">
            <Icon name="info" size={19} />
            <span><strong>Usage Guidelines</strong><small>minecraft.net</small></span>
            <Icon name="chevron-right" size={17} />
          </a>
        </nav>
      </section>
    </div>
  </div>

  <section class="card card-pad diagnostics" aria-labelledby="diagnostics-title">
    <div class="section-heading">
      <div>
        <h2 id="diagnostics-title">{t('about.diagnostics')}</h2>
        <p class="muted">{t('about.diagnosticsLead')}</p>
      </div>
      <span class="pill">{t('about.version', { version })}</span>
    </div>
    <dl>
      <div><dt>{t('about.platform')}</dt><dd>{diagnostics.platform}</dd></div>
      <div><dt>{t('about.renderer')}</dt><dd>{diagnostics.renderer}</dd></div>
      <div><dt>{t('about.storage')}</dt><dd>{diagnostics.storage}</dd></div>
    </dl>
  </section>
</div>

<style>
  .about { max-width: 1040px; }
  .hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 0.62fr); align-items: center; gap: var(--space-5); padding: var(--space-5); overflow: hidden; }
  .identity { display: flex; align-items: center; gap: var(--space-5); min-width: 0; }
  .mascot { width: clamp(88px, 13vw, 128px); height: auto; object-fit: contain; flex: none; }
  .identity-copy { display: grid; gap: var(--space-2); min-width: 0; }
  .wordmark { width: min(220px, 100%); height: auto; object-fit: contain; object-position: left center; }
  /* The wordmark's ink is dark; on a dark surface the name is set in type instead, like the sidebar. */
  .dark-wordmark { display: none; font-size: 30px; font-weight: 800; letter-spacing: -0.03em; color: var(--text); line-height: 1.1; }
  .dark-wordmark span { color: var(--accent-text); }
  :global([data-theme='dark']) .wordmark { display: none; }
  :global([data-theme='dark']) .dark-wordmark { display: block; }
  .identity-copy h2 { font-size: var(--text-lg); color: var(--text-secondary); font-weight: 600; }
  .hero-copy { color: var(--text-secondary); max-width: 34ch; }
  .columns { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr); gap: var(--space-5); align-items: start; }
  .side-stack { display: grid; gap: var(--space-5); min-width: 0; }
  .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
  .section-heading h2 { font-size: var(--text-xl); }
  .section-heading .muted { margin-top: var(--space-1); max-width: 54ch; }
  .coverage-group { display: grid; gap: var(--space-3); margin-top: var(--space-5); }
  .coverage-group h3 { font-size: var(--text-sm); }
  .format-list { list-style: none; display: grid; gap: var(--space-2); margin: 0; padding: 0; }
  .format-list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .format-list .pill { font-family: var(--font-mono); font-weight: 500; }
  .matrix-link { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border); color: var(--accent-text); font-weight: 600; text-decoration: none; }
  .matrix-link:hover { text-decoration: underline; }
  .matrix-link :global(.icon:last-child) { margin-inline-start: auto; }
  .side-stack :global(.callout) { height: 100%; }
  .side-stack :global(.callout-body) { display: grid; gap: var(--space-2); }
  .keychain-note { margin-top: var(--space-4); padding: var(--space-3); border-radius: var(--radius-md); background: var(--bg-sunken); color: var(--text-secondary); font-size: var(--text-sm); }
  .link-list { display: grid; gap: var(--space-2); margin-top: var(--space-4); }
  .required { font-weight: 700; color: var(--text); letter-spacing: 0.01em; }
  button.link-row { width: 100%; background: transparent; font: inherit; text-align: start; }
  .link-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 52px; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--text); text-decoration: none; }
  .link-row:hover { background: var(--bg-hover); border-color: var(--border-strong); }
  .link-row > :global(.icon:first-child) { color: var(--accent-text); }
  .link-row > :global(.icon:last-child) { color: var(--text-secondary); }
  .link-row span { display: grid; gap: 1px; min-width: 0; }
  .link-row strong { font-size: var(--text-sm); }
  .link-row small { overflow-wrap: anywhere; color: var(--text-secondary); font-size: var(--text-xs); }
  .diagnostics dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin: var(--space-5) 0 0; }
  .diagnostics dl > div { min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-sunken); }
  .diagnostics dt { color: var(--text-secondary); font-size: var(--text-xs); font-weight: 600; }
  .diagnostics dd { margin: var(--space-1) 0 0; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: var(--text-sm); }

  @media (max-width: 840px) {
    .hero, .columns { grid-template-columns: 1fr; }
    .hero-copy { max-width: 62ch; }
  }

  @media (max-width: 560px) {
    .hero { padding: var(--space-5); }
    .identity { align-items: flex-start; gap: var(--space-3); }
    .mascot { width: 80px; }
    .diagnostics dl { grid-template-columns: 1fr; }
    .section-heading { flex-direction: column; }
  }

  @media (max-width: 360px) {
    .hero { padding: var(--space-4); }
    .identity { display: grid; grid-template-columns: 64px minmax(0, 1fr); }
    .mascot { width: 64px; }
    .wordmark { width: 100%; }
    .identity-copy h2 { font-size: var(--text-md); }
    .card-pad { padding: var(--space-4); }
  }
</style>
