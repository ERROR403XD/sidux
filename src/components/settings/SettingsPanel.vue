<template>
  <div class="settings-page">
    <section id="accounts" class="settings-section"><h2>{{ t('账号与连接') }}</h2><slot name="accounts" /></section>
    <section class="settings-section"><h2>{{ t('通用') }}</h2><slot name="general" /></section>
    <section class="settings-section"><h2>{{ t('外观') }}</h2><slot name="appearance" /></section>
    <section class="settings-section"><h2>{{ t('输入与发送') }}</h2><slot name="input" /></section>
    <section class="settings-section"><h2>{{ t('集成') }}</h2><slot name="integrations" /></section>
    <section class="settings-section"><h2>{{ t('关于') }}</h2><slot name="about" /></section>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'
</script>
