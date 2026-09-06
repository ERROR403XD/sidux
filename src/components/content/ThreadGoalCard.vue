<template>
  <section class="thread-goal-card" aria-label="持续目标">
    <div class="thread-goal-card-heading"><span><IconTablerTarget />持续目标</span><strong>{{ goalStatusLabels[goal.status] }}</strong><button type="button" @click="emit('manage')">管理目标</button></div>
    <p class="thread-goal-card-objective">{{ goal.objective }}</p>
    <small>已用 {{ goal.tokensUsed.toLocaleString() }} tokens<template v-if="goal.tokenBudget != null"> / 预算 {{ formatGoalTokenBudget(goal.tokenBudget) }}</template><template v-else> · 不设预算</template> · {{ Math.round(goal.timeUsedSeconds / 60) }} 分钟</small>
  </section>
</template>
<script setup lang="ts">
import { formatGoalTokenBudget, goalStatusLabels, type ThreadGoal } from '../../api/threadCommands'
import IconTablerTarget from '../icons/IconTablerTarget.vue'
defineProps<{ goal: ThreadGoal }>()
const emit = defineEmits<{ manage: [] }>()
</script>
