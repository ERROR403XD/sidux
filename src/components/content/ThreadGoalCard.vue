<template>
  <section class="thread-goal-card" aria-label="持续目标">
    <div class="thread-goal-card-heading"><span><IconTablerTarget />持续目标</span><strong>{{ goalStatusLabels[goal.status] }}</strong><button type="button" @click="emit('manage')">管理目标</button></div>
    <p class="thread-goal-card-objective">{{ goal.objective }}</p>
    <small>Codex 计量 {{ goal.tokensUsed.toLocaleString() }} tokens<template v-if="goal.tokenBudget != null"> / 预算 {{ formatGoalTokenBudget(goal.tokenBudget) }}</template><template v-else> · 不设预算</template> · {{ Math.round(goal.timeUsedSeconds / 60) }} 分钟</small>
    <small v-if="goalBudgetRemaining(goal) != null" class="thread-goal-budget">剩余 {{ goalBudgetRemaining(goal)?.toLocaleString() }} tokens<template v-if="goal.tokenBudget != null && goal.tokensUsed > goal.tokenBudget"> · 超出 {{ (goal.tokensUsed - goal.tokenBudget).toLocaleString() }} tokens</template></small>
    <p v-if="goalUsageUnreported(goal)" class="thread-goal-hint">本次已运行，但 Codex 返回的用量为 0，剩余预算暂不显示。</p>
    <p v-if="goalStatusHint(goal)" class="thread-goal-hint" role="status">{{ goalStatusHint(goal) }}</p>
  </section>
</template>
<script setup lang="ts">
import { formatGoalTokenBudget, goalStatusLabels, type ThreadGoal } from '../../api/threadCommands'
import { goalBudgetRemaining, goalStatusHint, goalUsageUnreported } from '../../threadGoal'
import IconTablerTarget from '../icons/IconTablerTarget.vue'
defineProps<{ goal: ThreadGoal }>()
const emit = defineEmits<{ manage: [] }>()
</script>
