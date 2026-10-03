<script lang="ts">
  import { t } from '../lib/i18n/index.svelte';
  import Icon from './Icon.svelte';

  // The first step carries the legal notice. The text is the same as before the wizard existed.
</script>

<div class="welcome">
  <div class="brand" aria-hidden="true"><img src="/images/pomi.png" alt="" width="72" height="72" /></div>
  <p class="value">{t('setup.welcome.lead')}</p>
  <section aria-labelledby="notice-heading">
    <h3 id="notice-heading">{t('notice.title')}</h3>
    <ul class="notice-list">
      <li><Icon name="shield" size={19} /> <span>{t('notice.item1')}</span></li>
      <li><Icon name="language" size={19} /> <span>{t('notice.item2')}</span></li>
      <li><Icon name="info" size={19} /> <span>{t('notice.item3')}</span></li>
    </ul>
    <p class="required" lang="en">NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.</p>
  </section>
</div>

<style>
  .welcome { display: grid; gap: var(--space-4); }
  .brand { display: grid; place-items: center; }
  .brand img { width: 72px; height: 72px; object-fit: contain; outline: 1px solid var(--image-outline); outline-offset: -1px; border-radius: var(--radius-xl); }
  .value { margin: 0; text-align: center; color: var(--text); font-size: var(--text-lg); font-weight: 600; }
  section { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-page); }
  h3 { margin: 0; font-size: var(--text-md); color: var(--text); }
  .notice-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
  .notice-list li { display: grid; grid-template-columns: auto 1fr; align-items: start; gap: var(--space-3); }
  .notice-list :global(.icon) { color: var(--accent-text); margin-top: 2px; }
  .required { margin: 0; font-size: var(--text-xs); font-weight: 600; color: var(--text-secondary); letter-spacing: 0.01em; }
</style>
