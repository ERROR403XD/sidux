import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './style.css'
import { t } from './composables/useUiLanguage'
import { installFeedbackDiagnostics } from './composables/useFeedbackDiagnostics'

console.log('Welcome to Sidux. github: https://github.com/ERROR403XD/sidux')

installFeedbackDiagnostics()

createApp(App).use(router).mount('#app')
document.dispatchEvent(new Event('codexapp:mounted'))

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error(t('Service worker registration failed.'), error)
    })
  })
}
