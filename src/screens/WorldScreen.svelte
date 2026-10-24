<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { labelFor, t } from '../lib/i18n/index.svelte';
  import { baseName, formatDate, middleEllipsis } from '../lib/format';
  import Icon from '../components/Icon.svelte';
  import Callout from '../components/Callout.svelte';
  import SetupNotice from '../components/SetupNotice.svelte';
  import InterruptedWork from '../components/InterruptedWork.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import WorldCard from '../components/WorldCard.svelte';
  import WorldSummary from '../components/WorldSummary.svelte';
  import ListRow from '../components/ListRow.svelte';
  import StatusScreen from '../components/StatusScreen.svelte';
  import Pill from '../components/Pill.svelte';

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
  // "Overworld · The Nether · The End +1": one chip, not one chip per dimension.
  const dimensionText = $derived.by(() => {
    const names = dimensions.map((dim) => labelFor('world.dim', dim));
    return names.length > 3 ? `${names.slice(0, 3).join(' · ')} +${names.length - 3}` : names.join(' · ');
  });
  // The discovered list knows the world's own icon.png; the selected card borrows it.
  const selectedIcon = $derived(app.discovered.find((world) => world.path === app.worldDir)?.icon ?? '');
  const nothingYet = $derived(!app.worldDir && app.discoveredLoaded && app.discovered.length === 0 && app.recent.length === 0);
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
  <PageHeader title={t('world.title')} lead={t('world.lead')} />

  <InterruptedWork />

  {#if app.worldDir && app.inspection?.validJavaWorld}
    <WorldCard name={name} path={app.worldDir} icon={selectedIcon} eyebrow={t('world.selected')}>
      {#snippet actions()}
        <button type="button" class="btn btn-secondary btn-sm" disabled={app.isBusy} onclick={() => app.chooseWorld()}>
          <Icon name="folder" size={14} /> {t('world.openOther')}
        </button>
      {/snippet}

      <ul class="facts">
        <li><Pill tone="accent">{labelFor('world.kind', kind)}</Pill></li>
        {#if dimensionText}<li><Pill>{dimensionText}</Pill></li>{/if}
        {#if app.inspection?.resourcePacks?.length}<li><Pill>{t('world.resourcePack')}</Pill></li>{/if}
        <li><Pill>{t('world.backupsCount', { count: app.backups.length })}</Pill></li>
        {#if dataVersion}<li><Pill>{t('world.gameData', { version: dataVersion })}</Pill></li>{/if}
      </ul>

      <WorldSummary resume={false} showEmpty={false} />

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
    </WorldCard>
    <SetupNotice />
  {:else if nothingYet}
    <StatusScreen title={t('world.open')}>
      <p>{t('world.openHint')}</p>
      <p>{t('world.discoveredEmpty')}</p>
      {#snippet actions()}
        <button type="button" class="btn btn-primary btn-lg" onclick={() => app.chooseWorld()}><Icon name="folder" size={16} /> {t('world.open')}</button>
        <button type="button" class="btn btn-secondary btn-lg" disabled={app.isBusy} onclick={() => app.loadDiscovered(true)}><Icon name="refresh" size={16} /> {t('world.refresh')}</button>
      {/snippet}
    </StatusScreen>
  {:else}
    <section class="card empty">
      <div class="art" aria-hidden="true"><img src="/images/pomi.png" alt="" width="72" height="72" /></div>
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

  {#if !nothingYet}
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
                  <span class="p">{world.versionName ? `${world.folder} · ${world.versionName}` : world.folder}</span>
                  <span class="p when">{t('world.lastPlayed', { date: formatDate(world.lastPlayed, app.locale) })}</span>
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
        <ul class="list">
          {#each app.recent as world (world.path)}
            <ListRow selected={world.path === app.worldDir}>
              {#snippet leading()}<Icon name="folder" size={16} />{/snippet}
              <button
                type="button"
                class="open"
                disabled={!world.available || app.isBusy}
                aria-current={world.path === app.worldDir ? 'true' : undefined}
                onclick={() => app.useWorld(world.path)}
              >
                <span class="n truncate">{world.name || baseName(world.path)}</span>
                {#if world.path !== app.worldDir}<span class="p mono truncate" title={world.path}>{middleEllipsis(world.path, 56)}</span>{/if}
              </button>
              {#snippet trailing()}
                {#if !world.available}<Pill tone="warning" dot>{t('world.missing')}</Pill>
                {:else if world.lastOpened}<span class="when">{formatDate(world.lastOpened, app.locale)}</span>{/if}
                <button type="button" class="btn btn-quiet btn-icon btn-sm" disabled={app.isBusy} aria-label={t('world.forgetNamed', { name: world.name || baseName(world.path) })} title={t('world.forget')} onclick={() => app.forgetWorld(world.path)}>
                  <Icon name="x" size={16} />
                </button>
              {/snippet}
            </ListRow>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

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
  .facts { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
  .plain { margin: 0; padding-inline-start: 18px; }
  .small { font-size: var(--text-sm); }
  .found { display: grid; gap: var(--space-2); }
  .tiles { list-style: none; margin: var(--space-1) 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-3); }
  .tile { width: 100%; min-width: 0; display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: var(--space-3); align-items: center; padding: var(--space-3); text-align: start;
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-card); transition: border-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease); }
  .tile.current { border-color: var(--accent); background: var(--bg-selected); }
  .tile:disabled { opacity: 0.6; }
  @media (hover: hover) { .tile:not(:disabled):hover { border-color: var(--border-control); } }
  .icon-img { width: 48px; height: 48px; border-radius: var(--radius-md); image-rendering: pixelated; object-fit: cover; outline: 1px solid var(--image-outline); outline-offset: -1px; }
  .icon-img.placeholder { display: grid; place-items: center; background: var(--bg-sunken); color: var(--text-secondary); }
  .tile-text { display: grid; gap: 1px; min-width: 0; }
  .tile-text .n { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile-text .p { font-size: var(--text-xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The last-played line is the useful one: it wraps instead of being cut. */
  .tile-text .p.when { white-space: normal; overflow: visible; }
  .empty { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--space-5); padding: var(--space-5); border-style: dashed; border-color: var(--border-strong); box-shadow: none; }
  .art img { width: 72px; height: 72px; object-fit: contain; }
  .copy h2 { font-size: var(--text-xl); font-weight: 600; }
  .copy p { margin-top: var(--space-1); }
  .open { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: var(--space-3); padding: 0; border: 0; background: transparent; text-align: start; align-self: stretch; }
  .open:disabled { opacity: 0.6; }
  .open .n { font-weight: 600; flex: none; max-width: 50%; }
  .open .p { font-size: var(--text-xs); color: var(--text-secondary); min-width: 0; }
  .when { font-size: var(--text-xs); color: var(--text-secondary); white-space: nowrap; }
  @media (max-width: 760px) { .empty { grid-template-columns: 1fr; justify-items: start; } .when { display: none; } }
</style>
