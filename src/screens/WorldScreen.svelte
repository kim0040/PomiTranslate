<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { labelFor, t, type MessageKey } from '../lib/i18n/index.svelte';
  import { baseName, formatDate, middleEllipsis } from '../lib/format';
  import Icon from '../components/Icon.svelte';
  import Callout from '../components/Callout.svelte';
  import SetupNotice from '../components/SetupNotice.svelte';

  const dimensions = $derived.by(() => {
    const dirs = app.inspection?.regionDirs ?? [];
    const found = new Set<string>();
    for (const dir of dirs) {
      if (/^DIM-1\//.test(dir)) found.add('nether');
      else if (/^DIM1\//.test(dir)) found.add('end');
      else if (/^(region|entities)$/.test(dir)) found.add('overworld');
      else found.add('other');
    }
    return ['overworld', 'nether', 'end', 'other'].filter((name) => found.has(name));
  });
  const dataVersion = $derived(app.inspection?.dataVersions?.find((item) => item.dataVersion)?.dataVersion ?? null);
  const blockers = $derived(app.inspection?.writeBlockers ?? []);
  const blockerText = (code: string) => {
    return knownBlockers.includes(code) ? labelFor('world.blocked', code) : t('world.blocked.unknown');
  };
  const knownBlockers = ['bedrock', 'mcr', 'linear', 'world_in_use', 'not_writable', 'not_readable', 'missing', 'unsafe_path'];
  const name = $derived(app.worldDir ? baseName(app.worldDir) : '');
  $effect(() => { void app.loadDiscovered(); });

  function startScan(): void {
    app.goStep('scan');
    void app.startScan();
  }
  const kind = $derived((app.inspection?.kind ?? 'unknown') as 'java_world' | 'server_root' | 'unknown');
</script>

<div class="page">
  <header class="page-head">
    <h1>{t('world.title')}</h1>
    <p class="lead">{t('world.lead')}</p>
  </header>

  {#if app.worldDir && app.inspection?.validJavaWorld}
    <section class="card selected" aria-labelledby="selected-title">
      <div class="head">
        <div class="thumb" aria-hidden="true"><Icon name="folder" size={28} /></div>
        <div class="who">
          <p class="eyebrow" id="selected-title">{t('world.selected')}</p>
          <h2 class="name">{name}</h2>
          <p class="path mono truncate" title={app.worldDir}>{middleEllipsis(app.worldDir, 72)}</p>
        </div>
      </div>

      <ul class="facts">
        <li><span class="pill pill-accent">{labelFor('world.kind', kind)}</span></li>
        {#each dimensions as dim (dim)}<li><span class="pill">{labelFor('world.dim', dim)}</span></li>{/each}
        {#if app.inspection?.resourcePacks?.length}<li><span class="pill">{t('world.resourcePack')}</span></li>{/if}
        <li><span class="pill">{t('world.backupsCount', { count: app.backups.length })}</span></li>
        {#if dataVersion}<li><span class="pill num">{t('world.gameData', { version: dataVersion })}</span></li>{/if}
      </ul>

      {#if blockers.length}
        <Callout tone="danger" title={t('scan.blocked')} role="alert">
          <ul class="plain">
            {#each blockers as code (code)}<li>{knownBlockers.includes(code) ? blockerText(code) : t('world.blocked.unknown')}</li>{/each}
          </ul>
        </Callout>
      {/if}

      {#if app.resume}
        <Callout tone="info" title={t('world.resumeFound')}>
          {app.resume.status === 'cancelled'
            ? t('run.resumeInfoCancelled', { count: app.resume.translatedCount ?? 0 })
            : t('run.resumeInfo', { count: app.resume.translatedCount ?? 0 })}
          {#snippet actions()}
            <button type="button" class="btn btn-secondary btn-sm" onclick={() => app.goStep('run')}>{t('run.resume')}</button>
          {/snippet}
        </Callout>
      {/if}

      <div class="cta">
        <button type="button" class="btn btn-secondary" disabled={app.isBusy} onclick={() => app.chooseWorld()}>
          <Icon name="folder" size={16} /> {t('world.openOther')}
        </button>
      </div>
    </section>
    <SetupNotice />
  {:else}
    <section class="card empty">
      <div class="art" aria-hidden="true"><img src="/images/pomi.png" alt="" width="96" height="96" /></div>
      <div class="copy">
        <h2>{t('world.open')}</h2>
        <p class="muted">{t('world.openHint')}</p>
        <p class="muted small">{t('world.openHintDrop')}</p>
      </div>
      <button type="button" class="btn btn-primary btn-lg" onclick={() => app.chooseWorld()}>
        <Icon name="folder" size={16} /> {t('world.open')}
      </button>
    </section>
  {/if}

  <section class="found" aria-labelledby="found-title">
    <div class="section-row">
      <h2 id="found-title" class="section-title">{t('world.discovered')}</h2>
      <button type="button" class="btn btn-quiet btn-sm" disabled={app.isBusy} onclick={() => app.loadDiscovered(true)}><Icon name="refresh" size={14} /> {t('world.refresh')}</button>
    </div>
    <p class="muted small">{t('world.discoveredHelp')}</p>
    {#if app.discoveredLoaded && app.discovered.length === 0}
      <p class="muted">{t('world.discoveredEmpty')}</p>
    {:else if app.discovered.length}
      <ul class="tiles">
        {#each app.discovered as world (world.path)}
          <li>
            <button type="button" class="tile" class:current={world.path === app.worldDir} disabled={app.isBusy}
              aria-current={world.path === app.worldDir ? 'true' : undefined} title={world.path} onclick={() => app.useWorld(world.path)}>
              {#if world.icon}<img class="icon-img" src={world.icon} alt="" width="48" height="48" />
              {:else}<span class="icon-img placeholder" aria-hidden="true"><Icon name="folder" size={22} /></span>{/if}
              <span class="tile-text">
                <span class="n">{world.name}</span>
                <span class="p">{world.folder}{#if world.versionName} · {world.versionName}{/if}</span>
                <span class="p">{t('world.lastPlayed', { date: formatDate(world.lastPlayed, app.locale) })}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="recent" aria-labelledby="recent-title">
    <h2 id="recent-title" class="section-title">{t('world.recent')}</h2>
    {#if app.recent.length === 0}
      <p class="muted">{t('world.recentEmpty')}</p>
    {:else}
      <ul class="worlds">
        {#each app.recent as world (world.path)}
          <li class="world" class:current={world.path === app.worldDir}>
            <button
              type="button"
              class="open"
              disabled={!world.available || app.isBusy}
              aria-current={world.path === app.worldDir ? 'true' : undefined}
              onclick={() => app.useWorld(world.path)}
            >
              <span class="ico" aria-hidden="true"><Icon name="folder" size={20} /></span>
              <span class="txt">
                <span class="n">{world.name || baseName(world.path)}</span>
                {#if world.path !== app.worldDir}<span class="p mono truncate" title={world.path}>{middleEllipsis(world.path, 64)}</span>{/if}
              </span>
              <span class="meta">
                {#if !world.available}<span class="pill pill-warning">{t('world.missing')}</span>
                {:else if world.lastOpened}<span class="when">{formatDate(world.lastOpened, app.locale)}</span>{/if}
              </span>
            </button>
            <button type="button" class="btn btn-quiet btn-icon btn-sm" disabled={app.isBusy} aria-label={t('world.forgetNamed', { name: world.name || baseName(world.path) })} title={t('world.forget')} onclick={() => app.forgetWorld(world.path)}>
              <Icon name="x" size={16} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if app.worldDir && app.inspection?.validJavaWorld}
    <div class="action-bar">
      <p class="note">{app.scan ? t('world.scanKept') : t('world.scanNote')}</p>
      <div class="buttons">
        {#if app.scan}
          <button type="button" class="btn btn-primary btn-lg" disabled={blockers.length > 0} onclick={() => app.goStep('scan')}>
            {t('world.continue')} <Icon name="chevron-right" size={16} />
          </button>
        {:else}
          <button type="button" class="btn btn-primary btn-lg" disabled={blockers.length > 0 || app.isBusy} onclick={startScan}>
            <Icon name="search" size={16} /> {t('world.startScan')}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .selected { padding: var(--space-4); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .head { display: flex; gap: var(--space-4); align-items: center; min-width: 0; }
  .thumb { flex: none; display: grid; place-items: center; width: 48px; height: 48px; border-radius: var(--radius-lg); background: var(--accent-soft); color: var(--accent-soft-text); }
  .who { min-width: 0; }
  .name { font-size: var(--text-xl); margin-top: 2px; overflow-wrap: anywhere; }
  .path { font-size: var(--text-sm); color: var(--text-secondary); margin-top: 2px; }
  .facts { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
  .plain { margin: 0; padding-inline-start: 18px; }
  .cta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .small { font-size: var(--text-sm); }
  .found { display: grid; gap: var(--space-2); }
  .tiles { list-style: none; margin: var(--space-1) 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--space-2); }
  .tile { width: 100%; min-width: 0; display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: var(--space-3); align-items: center; padding: var(--space-2); text-align: start;
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); transition: border-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease); }
  .tile.current { border-color: var(--accent); background: var(--bg-selected); }
  .tile:disabled { opacity: 0.6; }
  @media (hover: hover) { .tile:not(:disabled):hover { border-color: var(--border-strong); } }
  .icon-img { width: 48px; height: 48px; border-radius: var(--radius-md); image-rendering: pixelated; object-fit: cover; outline: 1px solid var(--image-outline); outline-offset: -1px; }
  .icon-img.placeholder { display: grid; place-items: center; background: var(--bg-sunken); color: var(--text-secondary); }
  .tile-text { display: grid; min-width: 0; }
  .tile-text .n { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile-text .p { font-size: var(--text-xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--space-5); padding: var(--space-5); border-style: dashed; border-color: var(--border-strong); }
  .art img { width: 72px; height: 72px; object-fit: contain; }
  .copy h2 { font-size: var(--text-xl); }
  .copy p { margin-top: var(--space-1); }
  .worlds { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); min-width: 0; }
  .world { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); min-width: 0; }
  .open { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 44px; padding: 6px var(--space-3);
    min-width: 0; width: 100%; text-align: start; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); transition: border-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease); }
  .world.current .open { border-color: var(--accent); background: var(--bg-selected); }
  .open:disabled { opacity: 0.6; }
  .ico { display: grid; place-items: center; width: 30px; height: 30px; border-radius: var(--radius-md); background: var(--bg-sunken); color: var(--text-secondary); }
  .txt { display: grid; min-width: 0; }
  .n { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p { font-size: var(--text-xs); color: var(--text-secondary); }
  .when { font-size: var(--text-xs); color: var(--text-secondary); white-space: nowrap; }
  @media (hover: hover) { .open:not(:disabled):hover { border-color: var(--border-control); } }
  @media (max-width: 760px) { .empty { grid-template-columns: 1fr; justify-items: start; } .meta { display: none; } }
  @media (max-width: 420px) {
    .selected { padding: var(--space-4); }
    .head { align-items: flex-start; gap: var(--space-3); }
    .thumb { width: 48px; height: 48px; }
    .cta .btn { width: 100%; }
    .open { padding-inline: var(--space-2); gap: var(--space-2); }
  }
</style>
