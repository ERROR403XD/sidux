<template>
  <section class="thread-goal-card" :aria-label="t('持续目标')">
    <div class="thread-goal-card-heading"><span><IconTablerTarget />{{ t('持续目标') }}</span><strong>{{ t(goalStatusLabels[goal.status]) }}</strong><button type="button" @click="emit('manage')">{{ t('管理目标') }}</button></div>
    <p class="thread-goal-card-objective">{{ goal.objective }}</p>
    <small>{{ t('Codex 计量') }} {{ goal.tokensUsed.toLocaleString() }} tokens<template v-if="goal.tokenBudget != null"> {{ t('/ 预算') }} {{ formatGoalTokenBudget(goal.tokenBudget) }}</template><template v-else> {{ t('· 不设预算') }}</template> · {{ Math.round(goal.timeUsedSeconds / 60) }} {{ t('分钟') }}</small>
    <small v-if="goalBudgetRemaining(goal) != null" class="thread-goal-budget">{{ t('剩余') }} {{ goalBudgetRemaining(goal)?.toLocaleString() }} tokens<template v-if="goal.tokenBudget != null && goal.tokensUsed > goal.tokenBudget"> {{ t('· 超出') }} {{ (goal.tokensUsed - goal.tokenBudget).toLocaleString() }} tokens</template></small>
    <p v-if="goalUsageUnreported(goal)" class="thread-goal-hint">{{ t('Codex 返回用量为 0，暂不显示剩余预算。') }}</p>
    <p v-if="goalStatusHint(goal)" class="thread-goal-hint" role="status">{{ t(goalStatusHint(goal)) }}</p>
  </section>
</template>
<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { formatGoalTokenBudget, goalStatusLabels, type ThreadGoal } from '../../api/threadCommands'
import { goalBudgetRemaining, goalStatusHint, goalUsageUnreported } from '../../threadGoal'
import IconTablerTarget from '../icons/IconTablerTarget.vue'
defineProps<{ goal: ThreadGoal }>()
const emit = defineEmits<{ manage: [] }>()
</script>
