<template>
  <section class="thread-tree-root" :class="{ 'chats-first': showChatsFirst }">
    <p v-if="quotaResumeError" class="account-panel-error" role="alert">{{ t(quotaResumeError) }}</p>
    <p v-if="scheduledResumeError" class="account-panel-error" role="alert">{{ t(scheduledResumeError) }}</p>
    <section v-if="pinnedThreads.length > 0" class="pinned-section">
      <SidebarMenuRow
        as="button"
        class="section-toggle-row"
        type="button"
        :aria-expanded="isPinnedSectionExpanded"
        @click="togglePinnedSection"
      >
        <template #left>
          <IconTablerChevronRight v-if="!isPinnedSectionExpanded" class="thread-icon" />
          <IconTablerChevronDown v-else class="thread-icon" />
        </template>
        <span class="thread-tree-header">{{ t('Pinned') }}</span>
      </SidebarMenuRow>

      <ul v-if="isPinnedSectionExpanded || isSearchActive" class="thread-list">
        <SidebarThreadRow
          v-for="thread in pinnedThreads"
          :key="thread.id"
          :row="buildThreadRowModel(thread)"
          @select="onSelect"
          @delete="onInlineDeleteClick"
          @menu-toggle="toggleThreadMenu"
          @menu-leave="onThreadRowLeave"
          @menu-context="onThreadRowContextMenu"
          @menu-ref="setThreadMenuWrapRef"
        />
      </ul>
    </section>

    <section class="projects-section">
      <SidebarMenuRow
        as="div"
        class="thread-tree-header-row section-toggle-row"
        role="button"
        tabindex="0"
        :aria-expanded="isProjectsSectionExpanded"
        @click="toggleProjectsSection"
        @keydown.enter.self.prevent="toggleProjectsSection"
        @keydown.space.self.prevent="toggleProjectsSection"
      >
        <template #left>
          <IconTablerChevronRight v-if="!isProjectsSectionExpanded" class="thread-icon" />
          <IconTablerChevronDown v-else class="thread-icon" />
        </template>
        <span class="thread-tree-header">{{ t('Projects') }}</span>
        <template #right>
          <div class="projects-header-actions">
            <div ref="organizeMenuWrapRef" class="organize-menu-wrap">
              <button
                class="organize-menu-trigger"
                type="button"
                :aria-expanded="isOrganizeMenuOpen"
                :aria-label="t('Organize threads')"
                :title="t('Organize threads')"
                @click.stop="toggleOrganizeMenu"
              >
                <IconTablerDots class="thread-icon" />
              </button>

              <div v-if="isOrganizeMenuOpen" class="organize-menu-panel" @click.stop>
                <p class="organize-menu-title">{{ t('Organize') }}</p>
                <button
                  class="organize-menu-item"
                  :data-active="threadViewMode === 'project'"
                  type="button"
                  @click="setThreadViewMode('project')"
                >
                  <span>{{ t('By project') }}</span>
                  <span v-if="threadViewMode === 'project'">✓</span>
                </button>
                <button
                  class="organize-menu-item"
                  :data-active="threadViewMode === 'chronological'"
                  type="button"
                  @click="setThreadViewMode('chronological')"
                >
                  <span>{{ t('Chronological list') }}</span>
                  <span v-if="threadViewMode === 'chronological'">✓</span>
                </button>
                <button
                  class="organize-menu-item"
                  :data-active="showChatsFirst"
                  type="button"
                  @click="toggleShowChatsFirst"
                >
                  <span>{{ t('Chats first') }}</span>
                  <span v-if="showChatsFirst">✓</span>
                </button>
                <div class="organize-menu-separator" />
                <p class="organize-menu-title">{{ t('Sort by') }}</p>
                <button
                  class="organize-menu-item"
                  :data-active="chatSortMode === 'created'"
                  type="button"
                  @click="setChatSortMode('created')"
                >
                  <span>{{ t('Created') }}</span>
                  <span v-if="chatSortMode === 'created'">✓</span>
                </button>
                <button
                  class="organize-menu-item"
                  :data-active="chatSortMode === 'updated'"
                  type="button"
                  @click="setChatSortMode('updated')"
                >
                  <span>{{ t('Updated') }}</span>
                  <span v-if="chatSortMode === 'updated'">✓</span>
                </button>
              </div>
            </div>
            <button
              v-if="!isChronologicalView"
              class="project-tree-toggle"
              type="button"
              :disabled="groups.length === 0 || isSearchActive"
              :aria-label="canCollapseProjectTree ? t('Collapse all projects') : t('Expand all projects')"
              :title="canCollapseProjectTree ? t('Collapse all projects') : t('Expand all projects')"
              @click.stop="toggleAllProjectLevels"
            >
              <svg class="thread-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="canCollapseProjectTree ? 'm7 4 5 5 5-5M7 20l5-5 5 5' : 'm7 9 5-5 5 5M7 15l5 5 5-5'" />
              </svg>
            </button>
          </div>
        </template>
      </SidebarMenuRow>

      <template v-if="isProjectsSectionExpanded || isSearchActive">
      <p v-if="projectAutomationActionError" class="thread-tree-action-error">{{ t(projectAutomationActionError) }}</p>

      <p v-if="(isSearchActive || isStatusFilterActive) && !filterLoading && !(statusFilter === 'interrupted' && filterIncomplete) && searchState !== 'loading' && searchState !== 'error' && filteredGroups.length === 0 && globalThreads.length === 0 && pinnedThreads.length === 0" class="thread-tree-no-results">{{ t('No matching threads') }}</p>

      <p v-else-if="isLoading && groups.length === 0" class="thread-tree-loading">{{ t('Loading threads...') }}</p>

      <ul v-else-if="isChronologicalView" class="thread-list thread-list-global">
      <SidebarThreadRow
        v-for="thread in globalThreads"
        :key="thread.id"
        :row="buildThreadRowModel(thread)"
        @select="onSelect"
        @delete="onInlineDeleteClick"
        @menu-toggle="toggleThreadMenu"
        @menu-leave="onThreadRowLeave"
        @menu-context="onThreadRowContextMenu"
        @menu-ref="setThreadMenuWrapRef"
      />
      </ul>

    <div v-else ref="groupsContainerRef" class="thread-tree-groups" :style="groupsContainerStyle">
      <article
        v-for="group in filteredGroups"
        :key="group.projectName"
        :ref="(el) => setProjectGroupRef(group.projectName, el)"
        class="project-group"
        :data-project-name="group.projectName"
        :data-expanded="!isCollapsed(group.projectName)"
        :data-dragging="isDraggingProject(group.projectName)"
        :style="projectGroupStyle(group.projectName)"
      >
          <SidebarMenuRow
            as="div"
            class="project-header-row"
            role="button"
            tabindex="0"
            @click="toggleProjectCollapse(group.projectName)"
            @contextmenu.prevent="openProjectContextMenu($event, group.projectName)"
            @keydown="onProjectHeaderKeyDown($event, group.projectName)"
            @keydown.enter.self.prevent="toggleProjectCollapse(group.projectName)"
            @keydown.space.self.prevent="toggleProjectCollapse(group.projectName)"
          >
            <template #left>
              <span class="project-icon-stack">
                <span class="project-icon-folder">
                  <IconProjectOrganization v-if="isVirtualProjectId(group.projectName)" :expanded="!isCollapsed(group.projectName)" class="thread-icon" />
                  <IconTablerFolder v-else-if="isCollapsed(group.projectName)" class="thread-icon" />
                  <IconTablerFolderOpen v-else class="thread-icon" />
                </span>
                <span class="project-icon-chevron">
                  <IconTablerChevronRight v-if="isCollapsed(group.projectName)" class="thread-icon" />
                  <IconTablerChevronDown v-else class="thread-icon" />
                </span>
              </span>
            </template>
            <span
              class="project-main-button"
              :data-dragging-handle="isDraggingProject(group.projectName)"
              @mousedown.left="onProjectHandleMouseDown($event, group.projectName)"
            >
              <span class="project-title" :title="getProjectTooltipTitle(group.projectName)">
                {{ getProjectVisibleName(group) }}
              </span>
              <span
                v-if="projectHasAutomation(group.projectName)"
                class="thread-row-automation-chip"
                :title="projectAutomationTooltip(group.projectName)"
              >
                <IconTablerBolt class="thread-row-automation-icon" />
                <span v-if="projectAutomationCount(group.projectName) > 1" class="thread-row-automation-count">
                  {{ projectAutomationCount(group.projectName) }}
                </span>
              </span>
            </span>
            <template #right>
              <SidebarProjectMenu
                :project-name="group.projectName"
                :open="isProjectMenuOpen(group.projectName)"
                :context-point="projectContextPoint"
                @close="closeProjectMenu"
                :direction="projectMenuDirectionById[group.projectName] ?? 'down'"
                :has-automations="projectHasAutomation(group.projectName)"
                :has-git-repo="projectGitRepoByName[group.projectName]"
                :new-thread-label="getNewThreadButtonAriaLabel(group.projectName)"
                @toggle="toggleProjectMenu"
                @menu-ref="setProjectMenuWrapRef"
                @browse-files="onBrowseProjectFiles"
                @save-project="onSaveProject"
                @mark-read="onMarkProjectRead"
                @manage-automations="openProjectAutomationDialog"
                @create-worktree="onCreateProjectWorktree"
                @rename="openRenameProjectMenu(group)"
                @remove="onRemoveProject"
                @start-new-thread="onStartNewThread"
              />
            </template>
          </SidebarMenuRow>

          <ul v-if="hasThreads(group)" class="thread-list">
            <SidebarThreadRow
              v-for="thread in visibleThreads(group)"
              :key="thread.id"
              :row="buildThreadRowModel(thread)"
              @select="onSelect"
              @delete="onInlineDeleteClick"
              @menu-toggle="toggleThreadMenu"
              @menu-leave="onThreadRowLeave"
              @menu-context="onThreadRowContextMenu"
              @menu-ref="setThreadMenuWrapRef"
            />
          </ul>

          <SidebarMenuRow v-else-if="!isCollapsed(group.projectName)" as="p" class="project-empty-row">
            <template #left>
              <span class="project-empty-spacer" />
            </template>
            <span class="project-empty">{{ t('No threads') }}</span>
          </SidebarMenuRow>

          <SidebarMenuRow v-if="hasHiddenThreads(group)" class="thread-show-more-row">
            <template #left>
              <span class="thread-show-more-spacer" />
            </template>
            <button class="thread-show-more-button" type="button" @click="toggleProjectExpansion(group.projectName)">
              {{ isExpanded(group.projectName) ? t('Show less') : t('Show more') }}
            </button>
          </SidebarMenuRow>
      </article>
    </div>
      </template>
    </section>

    <section class="chats-section">
      <SidebarMenuRow
        as="div"
        class="section-toggle-row"
        role="button"
        tabindex="0"
        :aria-expanded="isChatsSectionExpanded"
        @click="toggleChatsSection"
        @keydown.enter.self.prevent="toggleChatsSection"
        @keydown.space.self.prevent="toggleChatsSection"
      >
        <template #left>
          <IconTablerChevronRight v-if="!isChatsSectionExpanded" class="thread-icon" />
          <IconTablerChevronDown v-else class="thread-icon" />
        </template>
        <span class="thread-tree-header">{{ t('Chats') }}</span>
        <template #right>
          <div class="chats-section-actions">
            <button
              class="chats-section-action"
              type="button"
              :aria-label="t('New chat')"
              :title="t('New chat')"
              @click.stop="$emit('start-new-chat')"
            >
              <IconTablerFilePencil class="thread-icon" />
            </button>
          </div>
        </template>
      </SidebarMenuRow>

      <p v-if="!isSearchActive && isChatsSectionExpanded && chatThreads.length === 0" class="thread-tree-no-results">{{ t('No chats') }}</p>
      <ul v-else-if="isChatsSectionExpanded || isSearchActive" class="thread-list thread-list-global">
        <SidebarThreadRow
          v-for="thread in visibleChatThreads"
          :key="thread.id"
          :row="buildThreadRowModel(thread)"
          @select="onSelect"
          @delete="onInlineDeleteClick"
          @menu-toggle="toggleThreadMenu"
          @menu-leave="onThreadRowLeave"
          @menu-context="onThreadRowContextMenu"
          @menu-ref="setThreadMenuWrapRef"
        />
      </ul>

      <SidebarMenuRow v-if="isChatsSectionExpanded && hasHiddenChatThreads" class="thread-show-more-row">
        <template #left>
          <span class="thread-show-more-spacer" />
        </template>
        <button class="thread-show-more-button" type="button" @click="toggleChatsListExpansion">
          {{ isChatsListExpanded ? t('Show less') : t('Show more') }}
        </button>
      </SidebarMenuRow>
    </section>

    <Teleport to="body">
      <div
        v-if="openThreadMenuThread"
        ref="openThreadMenuPanelRef"
        class="thread-menu-panel thread-menu-panel-fixed"
        :style="openThreadMenuStyle"
        :data-open-direction="getThreadMenuDirection(openThreadMenuThread.id)"
        @click.stop
      >
        <button v-if="interruptions?.[openThreadMenuThread.id]?.length" class="thread-menu-item" type="button" :disabled="ignoringProblems" @click="emit('ignore-thread-problems', openThreadMenuThread.id)">{{ t('忽略全部问题') }}</button>
        <button class="thread-menu-item" type="button" @click="onMarkThreadRead(openThreadMenuThread.id)">{{ t('标为已读') }}</button>
        <button class="thread-menu-item" type="button" :disabled="Boolean(quotaResumeMarks?.[openThreadMenuThread.id])" :title="quotaResumeMarks?.[openThreadMenuThread.id] ? t('已设置额度恢复续跑，请先取消。') : undefined" @click="openScheduledResume(openThreadMenuThread.id)">{{ t('定时续跑…') }}</button>
        <button v-if="scheduledResumeMarks?.[openThreadMenuThread.id]" class="thread-menu-item" type="button" @click="cancelScheduledResume(openThreadMenuThread.id)">{{ t('取消定时续跑') }}</button>
        <p v-if="interruptionError" class="sidebar-filter-error" role="alert">{{ t(interruptionError) }}</p>
        <button class="thread-menu-item" type="button" :disabled="quotaResumeDisabled(openThreadMenuThread.id)" :title="quotaResumeDisabled(openThreadMenuThread.id) ? t('已设置定时续跑，请先取消。') : undefined" @click="toggleQuotaResume(openThreadMenuThread.id)">{{ t(quotaResumeMarks?.[openThreadMenuThread.id] ? '取消额度恢复续跑' : '额度恢复后继续') }}</button>
        <button class="thread-menu-item" type="button" @click="openAutomationDialog(openThreadMenuThread.id)">
          {{ threadHasAutomation(openThreadMenuThread.id) ? t('Manage automations…') : t('Add automation…') }}
        </button>
        <button class="thread-menu-item" type="button" @click="onBrowseThreadFiles(openThreadMenuThread.id)">
          {{ t('Browse files') }}
        </button>
        <button class="thread-menu-item" type="button" @click="onSaveThreadProject(openThreadMenuThread.id)">
          {{ t('Export Project') }}
        </button>
        <button class="thread-menu-item" type="button" @click="onForkThread(openThreadMenuThread.id)">
          {{ t('Create chat fork') }}
        </button>
        <button v-if="isProjectlessChatPath(openThreadMenuThread.cwd) && projectMoveOptions.length > 1" class="thread-menu-item" type="button" @click="openMoveProjectDialog(openThreadMenuThread)">{{ t('移动到项目') }}</button>
        <button class="thread-menu-item" type="button" @click="onTogglePinFromMenu(openThreadMenuThread.id)">
          {{ isPinned(openThreadMenuThread.id) ? t('Unpin thread') : t('Pin thread') }}
        </button>
        <button class="thread-menu-item" type="button" @click="openRenameThreadDialog(openThreadMenuThread.id, openThreadMenuThread.title)">
          {{ t('Rename thread') }}
        </button>
        <button class="thread-menu-item thread-menu-item-danger" type="button" @click="openDeleteThreadDialog(openThreadMenuThread.id, openThreadMenuThread.title)">
          {{ t('Delete thread') }}
        </button>
      </div>
    </Teleport>

    <AppDialog :open="Boolean(scheduledResumeThreadId)" :title="t('定时续跑')" size="compact" :busy="scheduledResumeSaving" @close="scheduledResumeThreadId = ''">
      <label class="scheduled-resume-field">
        <span>{{ t('续跑时间') }}</span>
        <input v-model="scheduledResumeAt" class="app-input" type="datetime-local" data-autofocus :disabled="scheduledResumeSaving" :aria-label="t('续跑时间')" />
      </label>
      <p class="scheduled-resume-hint">{{ t('继承会话的模型和推理强度，到时继续之前的工作。') }}</p>
      <p class="scheduled-resume-hint">{{ t('时间以当前设备时区为准') }} · {{ deviceTimeZone }}</p>
      <p v-if="quotaResumeMarks?.[scheduledResumeThreadId]" class="account-panel-error" role="alert">{{ t('已设置额度恢复续跑，请先取消。') }}</p>
      <p v-if="scheduledResumeDialogError" class="account-panel-error" role="alert">{{ t(scheduledResumeDialogError) }}</p>
      <template #footer>
        <AppButton :disabled="scheduledResumeSaving" @click="scheduledResumeThreadId = ''">{{ t('Cancel') }}</AppButton>
        <AppButton :busy="scheduledResumeSaving" :disabled="Boolean(quotaResumeMarks?.[scheduledResumeThreadId])" @click="submitScheduledResume">{{ t('确认续跑时间') }}</AppButton>
      </template>
    </AppDialog>
    <AppDialog :open="renameThreadDialogVisible" :title="t('Rename thread')" size="compact" @close="closeRenameThreadDialog">
          <p class="rename-thread-subtitle">{{ t('Make it short and recognizable.') }}</p>
          <input
            ref="renameThreadInputRef"
            v-model="renameThreadDraft"
            class="rename-thread-input"
            type="text"
            :placeholder="t('Add title...')"
            @keydown.enter.prevent="submitRenameThread"
            @keydown.esc.prevent="closeRenameThreadDialog"
          />
      <template #footer>
          <div class="rename-thread-actions">
            <AppButton class="rename-thread-button" type="button" @click="closeRenameThreadDialog">{{ t('Cancel') }}</AppButton>
            <AppButton class="rename-thread-button rename-thread-button-primary" type="button" @click="submitRenameThread">{{ t('Save') }}</AppButton>
          </div>
      </template>
    </AppDialog>

    <AppDialog :open="deleteThreadDialogVisible" :title="deleteThreadHasAutomation ? t('Archive chat and remove automations?') : t('Delete thread?')" size="compact" @close="closeDeleteThreadDialog">
          <p class="rename-thread-subtitle">
            <template v-if="deleteThreadHasAutomation">
              {{ t('Archive {title} and remove its heartbeat automations.', { title: deleteThreadTitle }) }}
            </template>
            <template v-else>
              {{ t('Archive {title}. You can find it later in archived threads.', { title: deleteThreadTitle }) }}
            </template>
          </p>
      <template #footer>
          <div class="rename-thread-actions">
            <AppButton class="rename-thread-button" type="button" @click="closeDeleteThreadDialog">{{ t('Cancel') }}</AppButton>
            <AppButton class="rename-thread-button rename-thread-button-danger" variant="danger" type="button" @click="submitDeleteThread">
              {{ deleteThreadHasAutomation ? t('Archive and remove') : t('Delete') }}
            </AppButton>
          </div>
      </template>
    </AppDialog>

    <AppDialog :open="automationDialogVisible" :title="automationDialogMode === 'edit' ? t('Edit automation') : t('Add automation')" :busy="isSavingAutomation || isRunningAutomation" panel-class="automation-thread-panel" @close="closeAutomationDialog">
          <div class="automation-account-fields">
            <div class="automation-thread-field">
              <span class="automation-thread-label">{{ t('使用账号') }}</span>
              <AppSelect
                v-model="automationDraft.accountStorageId"
                class="automation-account-picker automation-thread-dropdown"
                :options="automationAccountOptions"
                enable-search
                :search-placeholder="t('搜索账号')"
                :disabled="isSavingAutomation || isRunningAutomation"
              />
            </div>
            <AppSwitch v-if="automationModelCapability?.providerId !== 'custom'" class="automation-protection-check" v-model="automationDraft.protected"  :disabled="isSavingAutomation || isRunningAutomation"><span>{{ t('受保护任务') }}</span>
            </AppSwitch>
          </div>

          <div v-if="automationTargetPickerVisible && automationDialogMode === 'create'" class="automation-target-picker">
            <span class="automation-thread-label">{{ t('Target') }}</span>
            <div class="automation-target-mode-group" role="radiogroup" :aria-label="t('Automation target type')">
              <AppButton
                class="automation-target-mode"
                :class="{ 'is-active': automationTargetMode === 'thread' }"
                role="radio"
                :aria-checked="automationTargetMode === 'thread'"
                type="button"
                @click="setAutomationTargetMode('thread')"
              >
                {{ t('Existing chat') }}
              </AppButton>
              <AppButton
                class="automation-target-mode"
                :class="{ 'is-active': automationTargetMode === 'project' }"
                role="radio"
                :aria-checked="automationTargetMode === 'project'"
                type="button"
                @click="setAutomationTargetMode('project')"
              >
                {{ t('Project') }}
              </AppButton>
            </div>

            <div class="automation-target-dropdown">
              <AppSelect
                v-model="automationTargetValue"
                class="automation-thread-dropdown"
                :options="automationTargetDropdownOptions"
                :placeholder="automationTargetMode === 'project' ? t('Select project') : t('Select chat')"
                enable-search
                :search-placeholder="automationTargetMode === 'project' ? t('Search projects') : t('Search chats')"
              />
            </div>
          </div>

          <label class="automation-thread-field">
            <span class="automation-thread-label">{{ t('Name') }}</span>
            <input v-model="automationDraft.name" class="rename-thread-input" type="text" :placeholder="t('Automation name')" />
          </label>

          <label class="automation-thread-field">
            <span class="automation-thread-label">{{ t('Prompt') }}</span>
            <textarea v-model="automationDraft.prompt" class="automation-thread-textarea" rows="6" :placeholder="t('Describe what the automation should do')"></textarea>
          </label>

          <p v-if="accountModelsError" role="alert">{{ t(accountModelsError) }}</p>
          <div class="automation-model-fields">
            <div class="automation-thread-field">
              <span class="automation-thread-label">{{ t('模型') }}</span>
              <AppSelect v-model="automationDraft.model" class="automation-model-picker automation-thread-dropdown" :options="automationModelOptions" enable-search :search-placeholder="t('搜索模型')" :disabled="isSavingAutomation || isRunningAutomation" />
            </div>
            <div class="automation-thread-field">
              <span class="automation-thread-label">{{ t('思考强度') }}</span>
              <AppSelect v-model="automationDraft.reasoningEffort" class="automation-effort-picker automation-thread-dropdown" :options="automationEffortOptions" :disabled="isSavingAutomation || isRunningAutomation || reasoningUnavailable(automationModelCapability)" />
            </div>
            <AppSwitch class="automation-fast-check" :title="t(automationFastControl.hint)" :model-value="automationFastControl.checked" :disabled="isSavingAutomation || isRunningAutomation || automationFastControl.disabled" @change="automationDraft.serviceTier = automationFastControl.nextValue">{{ t('快速模式') }} </AppSwitch>
          </div>

          <div class="automation-thread-field">
            <span class="automation-thread-label">{{ t('Schedule') }}</span>
            <div class="automation-schedule-mode-group" role="radiogroup" :aria-label="t('Automation schedule type')">
              <AppButton
                class="automation-schedule-mode"
                :class="{ 'is-active': automationScheduleDraft.mode === 'daily' }"
                type="button"
                @click="setAutomationScheduleMode('daily')"
              >
                {{ t('Daily') }}
              </AppButton>
              <AppButton
                class="automation-schedule-mode"
                :class="{ 'is-active': automationScheduleDraft.mode === 'interval' }"
                type="button"
                @click="setAutomationScheduleMode('interval')"
              >
                {{ t('Interval') }}
              </AppButton>
              <AppButton
                class="automation-schedule-mode"
                :class="{ 'is-active': automationScheduleDraft.mode === 'advanced' }"
                type="button"
                @click="setAutomationScheduleMode('advanced')"
              >
                RRULE
              </AppButton>
            </div>

            <div v-if="automationScheduleDraft.mode === 'daily'" class="automation-daily-times">
              <div class="activation-times-heading">
                <span>{{ t('Run every day at') }}</span>
                <AppButton :disabled="automationScheduleDraft.dailyTimes.length >= MAX_DAILY_TIMES" @click="addAutomationDailyTime">{{ t('添加时间') }}</AppButton>
              </div>
              <div class="activation-time-list">
                <p v-if="!automationScheduleDraft.dailyTimes.length">{{ t('尚未添加时间') }}</p>
                <div v-for="(_, index) in automationScheduleDraft.dailyTimes" :key="index" class="activation-time-row">
                  <AppTimeInput :model-value="automationScheduleDraft.dailyTimes[index] || ''" :aria-label="t('Run every day at') + ` ${index + 1}`" @update:model-value="automationScheduleDraft.dailyTimes[index] = $event" @change="syncAutomationRruleFromScheduleDraft" />
                  <AppButton @click="removeAutomationDailyTime(index)">{{ t('移除') }}</AppButton>
                </div>
              </div>
            </div>

            <div v-else-if="automationScheduleDraft.mode === 'interval'" class="automation-schedule-row">
              <span class="automation-schedule-copy">{{ t('Run every') }}</span>
              <input
                v-model.number="automationScheduleDraft.interval"
                class="automation-schedule-number"
                type="number"
                min="1"
                step="1"
                @input="syncAutomationRruleFromScheduleDraft"
              />
              <AppSelect
                class="automation-schedule-unit-dropdown"
                :model-value="automationScheduleDraft.intervalUnit"
                :options="automationIntervalUnitOptions"
                :placeholder="t('Unit')"
                @update:model-value="onAutomationIntervalUnitChange"
              />
            </div>

            <textarea
              v-if="automationScheduleDraft.mode === 'advanced'"
              v-model="automationDraft.rrule"
              class="rename-thread-input"
              rows="3"
              placeholder="FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
              @input="syncAutomationScheduleDraftFromRrule"
            />
            <p class="automation-schedule-preview">{{ t(automationSchedulePreview) }}</p>
          </div>

          <div class="automation-thread-field">
            <span class="automation-thread-label">{{ t('Status') }}</span>
            <AppSelect
              class="automation-thread-dropdown"
              :model-value="automationDraft.status"
              :options="automationStatusOptions"
              :placeholder="t('Status')"
              @update:model-value="onAutomationStatusChange"
            />
          </div>

          <p v-if="automationDialogError" class="rename-thread-subtitle automation-thread-error">{{ t(automationDialogError) }}</p>
      <template #footer>
          <div class="rename-thread-actions">
            <AppButton
              v-if="automationDialogMode === 'edit'"
              class="rename-thread-button"
              type="button"
              :disabled="isSavingAutomation || isRunningAutomation"
              @click="onRunAutomationFromDialog"
            >
              {{ isRunningAutomation ? t('Running…') : t('Run now') }}
            </AppButton>
            <AppButton
              v-if="automationDialogMode === 'edit'"
              class="rename-thread-button rename-thread-button-danger" variant="danger"
              type="button"
              :disabled="isSavingAutomation || isRunningAutomation"
              @click="requestDeleteAutomationFromDialog"
            >
              {{ t('Remove') }}
            </AppButton>
            <AppButton class="rename-thread-button" type="button" :disabled="isSavingAutomation || isRunningAutomation" @click="closeAutomationDialog">
              {{ t('Cancel') }}
            </AppButton>
            <AppButton class="rename-thread-button rename-thread-button-primary" type="button" :disabled="isSavingAutomation || isRunningAutomation" @click="submitAutomationDialog">
              {{ isSavingAutomation ? t('Saving…') : t('Save') }}
            </AppButton>
          </div>
      </template>
    </AppDialog>
    <AppDialog :open="Boolean(projectRemoval)" :title="t('移除项目及自动化任务？')" size="compact" @close="cancelProjectRemoval">
      <p>{{ t('移除“{name}”及其自动化任务？', { name: getProjectDisplayName(projectRemoval) }) }}</p>
      <template #footer>
        <AppButton data-autofocus @click="cancelProjectRemoval">{{ t('Cancel') }}</AppButton>
        <AppButton variant="danger" @click="confirmRemoveProjectAndAutomations">{{ t('Remove') }}</AppButton>
      </template>
    </AppDialog>

    <AppDialog :open="Boolean(automationRemoval)" :title="t('移除自动化任务？')" size="compact" :busy="isSavingAutomation" @close="cancelAutomationRemoval">
      <p>{{ t('确认移除“{name}”？', { name: automationRemoval?.name || '' }) }}</p>
      <template #footer>
        <AppButton data-autofocus :disabled="isSavingAutomation" @click="cancelAutomationRemoval">{{ t('Cancel') }}</AppButton>
        <AppButton variant="danger" :disabled="isSavingAutomation || isRunningAutomation" @click="onDeleteAutomationFromDialog">{{ t('Remove') }}</AppButton>
      </template>
    </AppDialog>

    <AppDialog :open="Boolean(projectMoveThread)" :title="t('移动到项目')" size="compact" @close="projectMoveThread = null">
      <AppSelect v-model="projectMoveTarget" :options="projectMoveOptions" :enable-search="true" :search-placeholder="t('Search projects')" />
      <template #footer>
        <AppButton @click="projectMoveThread = null">{{ t('Cancel') }}</AppButton>
        <AppButton @click="submitMoveProject">{{ t('Save') }}</AppButton>
      </template>
    </AppDialog>
  </section>
</template>

<script setup lang="ts">
import { isVirtualProjectId } from '../../projectOrganization'
import IconProjectOrganization from '../icons/IconProjectOrganization.vue'
import { notifyOperation } from '../../composables/useOperationToast'
import AppSwitch from '../common/AppSwitch.vue'
import { isOverlayEventInside } from '../../composables/overlayEvents'
import AppDialog from '../common/AppDialog.vue'
import AppButton from '../common/AppButton.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance, CSSProperties } from 'vue'
import { positionPopover } from '../common/popoverPosition'
import { getPinnedThreadState, persistPinnedThreadIds } from '../../api/threadPreferencesGateway'
import { getThreadSummary } from '../../api/threadReadGateway'
import type { UiProjectGroup, UiThread } from '../../types/codex'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import IconTablerFolder from '../icons/IconTablerFolder.vue'
import IconTablerFolderOpen from '../icons/IconTablerFolderOpen.vue'
import IconTablerBolt from '../icons/IconTablerBolt.vue'
import type { QuotaResumeMark } from '../../server/threadQuotaResume'
import type { ScheduledResumeMark } from '../../threadScheduledResume'
import type { ThreadGoal } from '../../api/threadCommands'
import { useUiLanguage } from '../../composables/useUiLanguage'
import { useFeedbackDiagnostics } from '../../composables/useFeedbackDiagnostics'
import { getPathLeafName, getPathParent, isProjectlessChatPath } from '../../pathUtils.js'
import AppTimeInput from '../common/AppTimeInput.vue'
import { MAX_DAILY_TIMES } from '../../automationDailyTimes'
import AppSelect from '../common/AppSelect.vue'
import { reasoningUnavailable, type ModelCapability } from '../../modelCapabilities'
import { useSidebarThreadProjection, type ChatSortMode, type SidebarThreadFilter } from '../../composables/sidebarThreadProjection'
import SidebarMenuRow from './SidebarMenuRow.vue'
import SidebarProjectMenu from './SidebarProjectMenu.vue'
import SidebarThreadRow, { type SidebarThreadRowModel } from './SidebarThreadRow.vue'
import { reconcilePinnedThreadIds } from './pinnedThreadUtils'
import type { ProjectMenuHandle } from './projectMenuHandle'
import { useSidebarAutomationController } from '../../composables/sidebarAutomationController'
import { threadInterruptionDot as problemDot, type ThreadInterruptionSnapshot, type ThreadInterruption } from '../../threadInterruption'

const props = defineProps<{
  groups: UiProjectGroup[]
  statusFilter?: SidebarThreadFilter
  retainedThreadId?: string
  activeRetainedIds?: ReadonlySet<string>
  interruptions?: ThreadInterruptionSnapshot
  ignoringProblems?: boolean
  interruptionError?: string
  quotaInterrupted?: Record<string, boolean | null>
  filterLoading?: boolean
  filterIncomplete?: boolean
  accounts?: { storageId: string; alias?: string; email: string | null; accountId: string }[]
  models?: string[]
  modelCapabilities?: ModelCapability[]
  goals?: Record<string, ThreadGoal | null>
  quotaResumeMarks?: Record<string, QuotaResumeMark>
  quotaResumeError?: string
  scheduledResumeMarks?: Record<string, ScheduledResumeMark>
  scheduledResumeError?: string
  scheduleResume?: (threadId: string, at: number | null) => Promise<boolean>
  projectDisplayNameById: Record<string, string>
  projectGitRepoByName: Record<string, boolean>
  projectCwdByName: Record<string, string>
  selectedThreadId: string
  isLoading: boolean
  isThreadListFullyLoaded: boolean
  searchQuery: string
  searchMatchedThreadIds: string[] | null
  searchState?: 'loading' | 'ready' | 'error'
}>()

function quotaResumeTitle(threadId: string): string {
  const status = props.quotaResumeMarks?.[threadId]?.status
  return t('额度恢复后继续') + ' · ' + t({ armed: '已启用', waiting: '等待额度', submitted: '已提交续跑', unknown: '提交结果待核对，请查看会话' }[status || 'armed'])
}
const { t } = useUiLanguage()
const { recordVisibleFailure } = useFeedbackDiagnostics()
const scheduledResumeThreadId = ref('')
const scheduledResumeAt = ref('')
const scheduledResumeSaving = ref(false)
const scheduledResumeDialogError = ref('')
const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
function quotaResumeDisabled(threadId: string): boolean {
  return Boolean(props.scheduledResumeMarks?.[threadId] && !props.quotaResumeMarks?.[threadId])
}
function toggleQuotaResume(threadId: string): void {
  if (quotaResumeDisabled(threadId)) return
  emit('toggle-quota-resume', threadId)
}
function openScheduledResume(threadId: string): void {
  if (props.quotaResumeMarks?.[threadId]) return
  const mark = props.scheduledResumeMarks?.[threadId]
  const at = new Date(mark?.at || Date.now() + 60 * 60_000)
  at.setMinutes(at.getMinutes() - at.getTimezoneOffset())
  scheduledResumeAt.value = at.toISOString().slice(0, 16)
  scheduledResumeThreadId.value = threadId
  scheduledResumeDialogError.value = ''
  closeThreadMenu()
}
async function submitScheduledResume(): Promise<void> {
  if (props.quotaResumeMarks?.[scheduledResumeThreadId.value]) return
  const at = new Date(scheduledResumeAt.value).getTime()
  if (!Number.isFinite(at) || at <= Date.now()) {
    scheduledResumeDialogError.value = '请选择未来的续跑时间'
    return
  }
  scheduledResumeSaving.value = true
  try {
    if (await props.scheduleResume?.(scheduledResumeThreadId.value, at)) {
      scheduledResumeThreadId.value = ''
    } else {
      scheduledResumeDialogError.value = props.scheduledResumeError || '定时续跑状态读取或保存失败'
    }
  } finally {
    scheduledResumeSaving.value = false
  }
}
async function cancelScheduledResume(threadId: string): Promise<void> {
  closeThreadMenu()
  await props.scheduleResume?.(threadId, null)
}
function scheduledResumeTitle(threadId: string): string {
  const mark = props.scheduledResumeMarks?.[threadId]
  if (!mark) return ''
  const status = { scheduled: '等待续跑', submitted: '已提交续跑', unknown: '提交结果待核对，请查看会话', failed: '定时续跑已中断，请查看会话。' }[mark.status]
  return `${t('定时续跑')} · ${new Date(mark.at).toLocaleString()} · ${t(status)}${mark.error ? ` · ${t(mark.error)}` : ''}`
}

const emit = defineEmits<{
  'move-conversation-project': [payload: { cwd: string; projectId: string | null }]
  'toggle-quota-resume': [threadId: string]
  'mark-project-read': [projectName: string]
  'mark-thread-read': [threadId: string]
  'ignore-thread-problems': [threadId: string]
  select: [threadId: string]
  archive: [threadId: string]
  'start-new-thread': [projectName: string]
  'browse-thread-files': [threadId: string]
  'save-thread-project': [threadId: string]
  'browse-project-files': [projectName: string]
  'save-project': [projectName: string]
  'request-project-git-status': [projectName: string]
  'create-project-worktree': [projectName: string]
  'edit-project': [projectName: string]
  'rename-thread': [payload: { threadId: string; title: string }]
  'remove-project': [projectName: string]
  'reorder-project': [payload: { projectName: string; toIndex: number }]
  'fork-thread': [threadId: string]
  'start-new-chat': []
  'automations-changed': []
}>()

const projectMoveThread = ref<UiThread | null>(null)
const projectMoveTarget = ref('')
const projectMoveOptions = computed(() => [
  { value: '', label: t('Projectless') },
  ...props.groups.filter(group => isVirtualProjectId(group.projectName)).map(group => ({ value: group.projectName, label: props.projectDisplayNameById[group.projectName] || group.projectName })),
])
function openMoveProjectDialog(thread: UiThread): void {
  projectMoveThread.value = thread
  projectMoveTarget.value = isVirtualProjectId(thread.projectName) ? thread.projectName : ''
  closeThreadMenu()
}
function submitMoveProject(): void {
  if (!projectMoveThread.value) return
  emit('move-conversation-project', { cwd: projectMoveThread.value.cwd, projectId: projectMoveTarget.value || null })
  projectMoveThread.value = null
}

type PendingProjectDrag = {
  projectName: string
  fromIndex: number
  startClientX: number
  startClientY: number
  pointerOffsetY: number
  groupLeft: number
  groupWidth: number
  groupHeight: number
  groupOuterHeight: number
}

type ActiveProjectDrag = {
  projectName: string
  fromIndex: number
  pointerOffsetY: number
  groupLeft: number
  groupWidth: number
  groupHeight: number
  groupOuterHeight: number
  ghostTop: number
  dropTargetIndexFull: number | null
}

type DragPointerSample = {
  clientX: number
  clientY: number
}

type MenuDirection = 'up' | 'down'

const DRAG_START_THRESHOLD_PX = 4
const PROJECT_GROUP_EXPANDED_GAP_PX = 6
const SECTION_EXPANSION_STORAGE_KEY = 'codex-web-local.sidebar-section-expansion.v1'
const CHATS_FIRST_STORAGE_KEY = 'codex-web-local.sidebar-chats-first.v1'
const CHAT_SORT_MODE_STORAGE_KEY = 'codex-web-local.sidebar-chat-sort-mode.v1'
const expandedProjects = ref<Record<string, boolean>>({})
const collapsedProjects = ref<Record<string, boolean>>({})
const isPinnedSectionExpanded = ref(true)
const isProjectsSectionExpanded = ref(true)
const isChatsSectionExpanded = ref(true)
const isChatsListExpanded = ref(false)
const showChatsFirst = ref(loadBooleanStorage(CHATS_FIRST_STORAGE_KEY, false))
const chatSortMode = ref<ChatSortMode>(loadChatSortMode())
let hasLoadedPinnedThreadState = false
const pinnedThreadIds = ref<string[]>([])
const hydratedPinnedThreadById = ref<Record<string, UiThread>>({})
const inlineDeleteConfirmThreadId = ref('')
const optimisticallyArchivedThreadIds = ref<string[]>([])
const openProjectMenuId = ref('')
const openThreadMenuId = ref('')
const projectMenuDirectionById = ref<Record<string, MenuDirection>>({})
const threadMenuDirectionById = ref<Record<string, MenuDirection>>({})
const openThreadMenuStyle = ref<CSSProperties>({})
const threadContextPoint = ref<{ x: number; y: number } | null>(null)
const projectContextPoint = ref<{ x: number; y: number } | null>(null)
const renameThreadDialogVisible = ref(false)
const renameThreadDialogThreadId = ref('')
const renameThreadDraft = ref('')
const renameThreadInputRef = ref<HTMLInputElement | null>(null)
const deleteThreadDialogVisible = ref(false)
const deleteThreadDialogThreadId = ref('')
const deleteThreadTitle = ref('')
let sidebarStopped = false

const {
  projectRemoval,
  automationDialogVisible,
  automationRemoval,
  automationDialogMode,
  automationTargetPickerVisible,
  automationTargetMode,
  automationDialogError,
  projectAutomationActionError,
  isSavingAutomation,
  isRunningAutomation,
  accountModelsError,
  automationDraft,
  automationScheduleDraft,
  automationTargetValue,
  automationAccountOptions,
  automationModelOptions,
  automationModelCapability,
  automationFastControl,
  automationEffortOptions,
  automationSchedulePreview,
  automationTargetDropdownOptions,
  automationIntervalUnitOptions,
  automationStatusOptions,
  threadHasAutomation,
  threadAutomationCount,
  projectHasAutomation,
  projectAutomationCount,
  threadAutomationTooltip,
  projectAutomationTooltip,
  syncAutomationRruleFromScheduleDraft,
  addAutomationDailyTime,
  removeAutomationDailyTime,
  onAutomationIntervalUnitChange,
  onAutomationStatusChange,
  syncAutomationScheduleDraftFromRrule,
  setAutomationScheduleMode,
  openAutomationDialog,
  openProjectAutomationDialog,
  openAutomationEditorFromPanel,
  openAutomationCreatorFromPanel,
  setAutomationTargetMode,
  closeAutomationDialog,
  submitAutomationDialog,
  requestDeleteAutomationFromDialog,
  onDeleteAutomationFromDialog,
  onRunAutomationFromDialog,
  setAutomationMaps,
  onRemoveProject,
  confirmRemoveProjectAndAutomations,
  removeArchivedThreadAutomations,
  cancelProjectRemoval,
  cancelAutomationRemoval,
} = useSidebarAutomationController({
  getGroups: () => props.groups,
  getAccounts: () => props.accounts,
  getModels: () => props.models,
  getModelCapabilities: () => props.modelCapabilities,
  getProjectCwd: projectName => props.projectCwdByName[projectName],
  getProjectDisplayName,
  t,
  closeProjectMenu,
  closeThreadMenu,
  removeProject: projectName => emit('remove-project', projectName),
  automationsChanged: () => emit('automations-changed'),
  notifyOperation,
  recordVisibleFailure,
})
const groupsContainerRef = ref<HTMLElement | null>(null)
const pendingProjectDrag = ref<PendingProjectDrag | null>(null)
const activeProjectDrag = ref<ActiveProjectDrag | null>(null)
let pendingDragPointerSample: DragPointerSample | null = null
let dragPointerRafId: number | null = null
const suppressNextProjectToggleId = ref('')
const measuredHeightByProject = ref<Record<string, number>>({})
const projectGroupElementByName = new Map<string, HTMLElement>()
const projectMenuHandleByName = new Map<string, ProjectMenuHandle>()
const threadMenuWrapElementById = new Map<string, HTMLElement>()
const projectNameByElement = new WeakMap<HTMLElement, string>()
const organizeMenuWrapRef = ref<HTMLElement | null>(null)
const openThreadMenuPanelRef = ref<HTMLElement | null>(null)
const isOrganizeMenuOpen = ref(false)
const THREAD_VIEW_MODE_STORAGE_KEY = 'codex-web-local.thread-view-mode.v1'
const threadViewMode = ref<'project' | 'chronological'>(loadThreadViewMode())
let projectMeasureFrame = 0
const pendingProjectMeasurements = new Set<HTMLElement>()
const projectGroupResizeObserver =
  typeof window !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) pendingProjectMeasurements.add(entry.target as HTMLElement)
        if (projectMeasureFrame) return
        projectMeasureFrame = requestAnimationFrame(() => {
          projectMeasureFrame = 0
          for (const element of pendingProjectMeasurements) {
            const projectName = projectNameByElement.get(element)
            if (projectName && element.isConnected && projectGroupElementByName.get(projectName) === element) {
              updateMeasuredProjectHeight(projectName, element)
            }
          }
          pendingProjectMeasurements.clear()
        })
      })
    : null
const COLLAPSED_STORAGE_KEY = 'codex-web-local.collapsed-projects.v1'

function loadCollapsedState(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, boolean>
  } catch {
    return {}
  }
}

function loadThreadViewMode(): 'project' | 'chronological' {
  if (typeof window === 'undefined') return 'project'

  const raw = window.localStorage.getItem(THREAD_VIEW_MODE_STORAGE_KEY)
  return raw === 'chronological' ? 'chronological' : 'project'
}

function loadBooleanStorage(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  const raw = window.localStorage.getItem(key)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

function loadChatSortMode(): ChatSortMode {
  if (typeof window === 'undefined') return 'updated'
  return window.localStorage.getItem(CHAT_SORT_MODE_STORAGE_KEY) === 'created' ? 'created' : 'updated'
}

collapsedProjects.value = loadCollapsedState()

function loadSectionExpansionState(): void {
  if (typeof window === 'undefined') return

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SECTION_EXPANSION_STORAGE_KEY) || '{}') as {
      pinned?: unknown
      projects?: unknown
      chats?: unknown
    }
    if (typeof parsed.pinned === 'boolean') isPinnedSectionExpanded.value = parsed.pinned
    if (typeof parsed.projects === 'boolean') isProjectsSectionExpanded.value = parsed.projects
    if (typeof parsed.chats === 'boolean') isChatsSectionExpanded.value = parsed.chats
  } catch {
    // Keep default expanded state when saved state is invalid.
  }
}

function persistSectionExpansionState(): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(
    SECTION_EXPANSION_STORAGE_KEY,
    JSON.stringify({
      pinned: isPinnedSectionExpanded.value,
      projects: isProjectsSectionExpanded.value,
      chats: isChatsSectionExpanded.value,
    }),
  )
}

loadSectionExpansionState()

watch(
  collapsedProjects,
  (value) => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(value))
  },
  { deep: true },
)

watch(threadViewMode, (value) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_VIEW_MODE_STORAGE_KEY, value)
})

watch(showChatsFirst, (value) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(CHATS_FIRST_STORAGE_KEY, String(value))
})

watch(chatSortMode, (value) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(CHAT_SORT_MODE_STORAGE_KEY, value)
})

watch([isPinnedSectionExpanded, isProjectsSectionExpanded, isChatsSectionExpanded], persistSectionExpansionState)

const {
  isStatusFilterActive,
  isSearchActive,
  filteredGroups,
  globalThreads,
  chatThreads,
  pinnedThreadIdSet,
  optimisticallyArchivedThreadIdSet,
  threadById,
  threadTimestampById,
  unpinnedThreadsByProjectName,
  threadMatchesSearch,
  compareSearchRank,
} = useSidebarThreadProjection({
  groups: computed(() => props.groups),
  statusFilter: computed(() => props.statusFilter),
  retainedThreadId: computed(() => props.retainedThreadId),
  activeRetainedIds: computed(() => props.activeRetainedIds),
  quotaInterrupted: computed(() => props.quotaInterrupted),
  optimisticallyArchivedThreadIds: optimisticallyArchivedThreadIds,
  pinnedThreadIds,
  searchQuery: computed(() => props.searchQuery),
  searchMatchedThreadIds: computed(() => props.searchMatchedThreadIds),
  chatSortMode,
})

const isChronologicalView = computed(() => threadViewMode.value === 'chronological')

const visibleChatThreads = computed(() => {
  if (isSearchActive.value) return chatThreads.value
  return isChatsListExpanded.value ? chatThreads.value : chatThreads.value.slice(0, 10)
})

const hasHiddenChatThreads = computed(() => {
  if (isSearchActive.value) return false
  return chatThreads.value.length > 10
})

watch(
  pinnedThreadIds,
  (threadIds) => {
    if (!hasLoadedPinnedThreadState) return
    void persistPinnedThreadIds(threadIds)
  },
)

watch([threadById, () => props.isThreadListFullyLoaded], ([threadsById]) => {
  const filtered = reconcilePinnedThreadIds(pinnedThreadIds.value, new Set(threadsById.keys()), {
    canPruneMissing: props.isThreadListFullyLoaded,
  })
  if (filtered.length === pinnedThreadIds.value.length) return
  const filteredIdSet = new Set(filtered)
  const nextHydratedPinnedThreads = Object.fromEntries(
    Object.entries(hydratedPinnedThreadById.value).filter(([threadId]) => filteredIdSet.has(threadId)),
  )
  hydratedPinnedThreadById.value = nextHydratedPinnedThreads
  pinnedThreadIds.value = filtered
})

let pinnedThreadHydrationVersion = 0

async function hydrateMissingPinnedThreads(): Promise<void> {
  if (sidebarStopped || props.isLoading) return
  const missingThreadIds = pinnedThreadIds.value.filter((threadId) => !threadById.value.has(threadId) && !hydratedPinnedThreadById.value[threadId])
  if (missingThreadIds.length === 0) return

  const version = (pinnedThreadHydrationVersion += 1)
  const loadedThreads = await Promise.all(
    missingThreadIds.map(async (threadId) => {
      try {
        return await getThreadSummary(threadId)
      } catch {
        return null
      }
    }),
  )
  if (sidebarStopped || version !== pinnedThreadHydrationVersion) return

  const next = { ...hydratedPinnedThreadById.value }
  for (const thread of loadedThreads) {
    if (thread) next[thread.id] = thread
  }
  hydratedPinnedThreadById.value = next
}

watch([pinnedThreadIds, threadById, () => props.isLoading], () => {
  if (!hasLoadedPinnedThreadState) return
  void hydrateMissingPinnedThreads()
})

onMounted(async () => {
  const { threadIds } = await getPinnedThreadState()
  if (sidebarStopped) return
  const normalized = Array.isArray(threadIds)
    ? threadIds
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item, index, rows) => item.length > 0 && rows.indexOf(item) === index)
    : []

  if (normalized.length > 0) {
    pinnedThreadIds.value = normalized
  }
  hasLoadedPinnedThreadState = true
  void hydrateMissingPinnedThreads()
})

const deleteThreadHasAutomation = computed(() => threadHasAutomation(deleteThreadDialogThreadId.value))

const threadProjectNameById = computed(() => {
  const map = new Map<string, string>()
  for (const group of props.groups) {
    for (const thread of group.threads) {
      map.set(thread.id, group.projectName)
    }
  }
  return map
})
const openThreadMenuThread = computed(() => {
  const threadId = openThreadMenuId.value
  return threadId ? (threadById.value.get(threadId) ?? null) : null
})

const pinnedThreads = computed(() =>
  pinnedThreadIds.value
    .map((threadId) => threadById.value.get(threadId) ?? hydratedPinnedThreadById.value[threadId] ?? null)
    .filter((thread): thread is UiThread => thread !== null)
    .filter(threadMatchesSearch)
    .sort(compareSearchRank),
)

function togglePinnedSection(): void {
  isPinnedSectionExpanded.value = !isPinnedSectionExpanded.value
}

function toggleProjectsSection(): void {
  isProjectsSectionExpanded.value = !isProjectsSectionExpanded.value
}

function toggleChatsSection(): void {
  isChatsSectionExpanded.value = !isChatsSectionExpanded.value
}

const projectedDropProjectIndex = computed<number | null>(() => {
  const drag = activeProjectDrag.value
  if (!drag || drag.dropTargetIndexFull === null || props.groups.length === 0) return null

  const boundedDropIndex = Math.max(0, Math.min(drag.dropTargetIndexFull, props.groups.length))
  const projectedIndex = boundedDropIndex > drag.fromIndex ? boundedDropIndex - 1 : boundedDropIndex
  const boundedProjectedIndex = Math.max(0, Math.min(projectedIndex, props.groups.length - 1))
  return boundedProjectedIndex === drag.fromIndex ? null : boundedProjectedIndex
})

const layoutProjectOrder = computed<string[]>(() => {
  const sourceGroups = isSearchActive.value || isStatusFilterActive.value ? filteredGroups.value : props.groups
  const names = sourceGroups.map((group) => group.projectName)
  const drag = activeProjectDrag.value
  const projectedIndex = projectedDropProjectIndex.value

  if (!drag || projectedIndex === null) {
    return names
  }

  const next = [...names]
  const [movedProject] = next.splice(drag.fromIndex, 1)
  if (!movedProject) {
    return names
  }
  next.splice(projectedIndex, 0, movedProject)
  return next
})

const layoutTopByProject = computed<Record<string, number>>(() => {
  const topByProject: Record<string, number> = {}
  let currentTop = 0

  for (const projectName of layoutProjectOrder.value) {
    topByProject[projectName] = currentTop
    currentTop += getProjectOuterHeight(projectName)
  }

  return topByProject
})

const groupsContainerStyle = computed<Record<string, string>>(() => {
  let totalHeight = 0
  for (const projectName of layoutProjectOrder.value) {
    totalHeight += getProjectOuterHeight(projectName)
  }

  return {
    height: `${Math.max(0, totalHeight)}px`,
  }
})

function formatRelative(timestamp: number): string {
  if (Number.isNaN(timestamp)) return 'n/a'

  const diffMs = Math.abs(Date.now() - timestamp)
  if (diffMs < 60000) return 'now'

  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  return `${days}d`
}

function formatRelativeThread(thread: UiThread): string {
  const timestamp = threadTimestampById.value.get(thread.id)
  if (typeof timestamp === 'number') {
    return formatRelative(timestamp)
  }
  return formatRelative(new Date(thread.updatedAtIso || thread.createdAtIso).getTime())
}

function buildThreadRowModel(thread: UiThread): SidebarThreadRowModel {
  return {
    thread,
    selected: thread.id === props.selectedThreadId,
    pinned: isPinned(thread.id),
    menuOpen: isThreadMenuOpen(thread.id),
    deleteConfirming: isInlineDeleteConfirming(thread.id),
    statusIndicator: shouldShowThreadIndicator(thread)
      ? { state: getThreadState(thread), title: threadIndicatorTitle(thread) }
      : null,
    automationCount: threadAutomationCount(thread.id),
    automationTitle: threadAutomationTooltip(thread.id),
    goal: props.goals?.[thread.id],
    quotaResumeTitle: props.quotaResumeMarks?.[thread.id] ? quotaResumeTitle(thread.id) : '',
    scheduledResumeTitle: scheduledResumeTitle(thread.id),
    requestLabel: threadRequestLabel(thread),
    relativeTime: t(formatRelativeThread(thread)),
  }
}

function isPinned(threadId: string): boolean {
  return pinnedThreadIdSet.value.has(threadId)
}

function togglePin(threadId: string): void {
  if (isPinned(threadId)) {
    pinnedThreadIds.value = pinnedThreadIds.value.filter((id) => id !== threadId)
    return
  }

  pinnedThreadIds.value = [threadId, ...pinnedThreadIds.value]
}

function onTogglePinFromMenu(threadId: string): void {
  togglePin(threadId)
  closeThreadMenu()
}

function onSelect(threadId: string): void {
  inlineDeleteConfirmThreadId.value = ''
  emit('select', threadId)
}

function onMarkProjectRead(projectName: string): void {
  emit('mark-project-read', projectName)
  closeProjectMenu()
}

function onMarkThreadRead(threadId: string): void {
  emit('mark-thread-read', threadId)
  closeThreadMenu()
}

function onForkThread(threadId: string): void {
  emit('fork-thread', threadId)
  closeThreadMenu()
}

function getNewThreadButtonAriaLabel(projectName: string): string {
  return `start new thread ${getProjectDisplayName(projectName)}`
}

function onStartNewThread(projectName: string): void {
  emit('start-new-thread', projectName)
}

function onBrowseThreadFiles(threadId: string): void {
  emit('browse-thread-files', threadId)
  closeThreadMenu()
}

function onSaveThreadProject(threadId: string): void {
  emit('save-thread-project', threadId)
  closeThreadMenu()
}

function onThreadRowLeave(threadId: string, event?: MouseEvent): void {
  if (threadContextPoint.value) return
  if (openThreadMenuId.value !== threadId) return
  if (event) {
    const relatedTarget = event.relatedTarget
    const panelElement = openThreadMenuPanelRef.value
    if (relatedTarget instanceof Node && panelElement && panelElement.contains(relatedTarget)) return
  }
  closeThreadMenu()
}

function isThreadMenuOpen(threadId: string): boolean {
  return openThreadMenuId.value === threadId
}

function closeThreadMenu(): void {
  threadContextPoint.value = null
  openThreadMenuId.value = ''
  openThreadMenuStyle.value = {}
}

function toggleThreadMenu(threadId: string): void {
  threadContextPoint.value = null
  inlineDeleteConfirmThreadId.value = ''
  if (openThreadMenuId.value === threadId) {
    closeThreadMenu()
    return
  }

  closeProjectMenu()
  isOrganizeMenuOpen.value = false
  openThreadMenuId.value = threadId
  nextTick(() => {
    updateOpenThreadMenuPlacement(threadId)
  })
}

function onThreadRowContextMenu(event: MouseEvent, threadId: string): void {
  event.preventDefault()
  closeProjectMenu()
  isOrganizeMenuOpen.value = false
  inlineDeleteConfirmThreadId.value = ''
  threadContextPoint.value = { x: event.clientX, y: event.clientY }
  openThreadMenuId.value = threadId
  nextTick(() => updateOpenThreadMenuPlacement(threadId))
}

function openRenameThreadDialog(threadId: string, currentTitle: string): void {
  renameThreadDialogThreadId.value = threadId
  renameThreadDraft.value = currentTitle
  renameThreadDialogVisible.value = true
  closeThreadMenu()
  nextTick(() => {
    renameThreadInputRef.value?.focus()
    renameThreadInputRef.value?.select()
  })
}

function closeRenameThreadDialog(): void {
  renameThreadDialogVisible.value = false
  renameThreadDialogThreadId.value = ''
  renameThreadDraft.value = ''
}

function submitRenameThread(): void {
  const threadId = renameThreadDialogThreadId.value
  const title = renameThreadDraft.value.trim()
  if (!threadId || !title) return
  emit('rename-thread', { threadId, title })
  closeRenameThreadDialog()
}

function openDeleteThreadDialog(threadId: string, currentTitle: string): void {
  inlineDeleteConfirmThreadId.value = ''
  deleteThreadDialogThreadId.value = threadId
  deleteThreadTitle.value = currentTitle
  deleteThreadDialogVisible.value = true
  closeThreadMenu()
}

function closeDeleteThreadDialog(): void {
  deleteThreadDialogVisible.value = false
  deleteThreadDialogThreadId.value = ''
  deleteThreadTitle.value = ''
}

async function submitDeleteThread(): Promise<void> {
  const threadId = deleteThreadDialogThreadId.value
  if (!threadId) return
  deleteThreadById(threadId)
  closeDeleteThreadDialog()
}

function isInlineDeleteConfirming(threadId: string): boolean {
  return inlineDeleteConfirmThreadId.value === threadId
}

function onInlineDeleteClick(threadId: string): void {
  if (inlineDeleteConfirmThreadId.value !== threadId) {
    inlineDeleteConfirmThreadId.value = threadId
    closeThreadMenu()
    return
  }

  deleteThreadById(threadId)
  inlineDeleteConfirmThreadId.value = ''
}

function deleteThreadById(threadId: string): void {
  if (sidebarStopped) return
  if (!optimisticallyArchivedThreadIdSet.value.has(threadId)) {
    optimisticallyArchivedThreadIds.value = [threadId, ...optimisticallyArchivedThreadIds.value]
  }
  inlineDeleteConfirmThreadId.value = ''
  closeThreadMenu()
  pinnedThreadIds.value = pinnedThreadIds.value.filter((id) => id !== threadId)
  emit('archive', threadId)

  removeArchivedThreadAutomations(threadId)
}

function getProjectDisplayName(projectName: string): string {
  return props.projectDisplayNameById[projectName] ?? projectName
}

defineExpose({
  setAutomationMaps,
  openAutomationEditorFromPanel,
  openAutomationCreatorFromPanel,
})

function isPathLikeProjectName(value: string): boolean {
  return value.includes('/') || value.includes('\\')
}

function getProjectTooltipTitle(projectName: string): string {
  if (isVirtualProjectId(projectName)) return getProjectDisplayName(projectName)
  return props.projectCwdByName[projectName]?.trim() || (isPathLikeProjectName(projectName) ? projectName : getProjectDisplayName(projectName))
}

function isDuplicatePathLeafName(value: string): boolean {
  const leafName = getPathLeafName(value)
  if (!leafName) return false
  let matchingCount = 0
  for (const group of props.groups) {
    if (!isPathLikeProjectName(group.projectName)) continue
    if (getPathLeafName(group.projectName) !== leafName) continue
    matchingCount += 1
    if (matchingCount > 1) return true
  }
  return false
}

function getProjectVisibleName(group: UiProjectGroup): string {
  if (isVirtualProjectId(group.projectName)) return getProjectDisplayName(group.projectName)
  const customDisplayName = props.projectDisplayNameById[group.projectName]
  const displayName = getProjectDisplayName(group.projectName)
  const projectName = group.projectName
  if (customDisplayName && !isPathLikeProjectName(projectName) && projectName !== displayName) {
    if (displayName.includes(projectName) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(projectName)) return displayName
    return `${displayName} ${projectName}`
  }
  if (customDisplayName && isPathLikeProjectName(projectName)) {
    const leafName = getPathLeafName(projectName)
    const parentLeafName = getPathLeafName(getPathParent(projectName))
    const contextName = isDuplicatePathLeafName(projectName) ? parentLeafName : leafName
    return contextName && contextName !== displayName ? `${displayName} ${contextName}` : displayName
  }
  if (!displayName.includes('/') && !displayName.includes('\\')) return displayName
  const leafName = getPathLeafName(displayName) || displayName
  const parentLeafName = getPathLeafName(getPathParent(displayName))
  if (parentLeafName.startsWith('.') && parentLeafName !== leafName) return `${leafName} ${parentLeafName}`
  if (group.threads.length > 0 || !isDuplicatePathLeafName(projectName)) return leafName
  return parentLeafName ? `${leafName} ${parentLeafName}` : leafName
}

function isProjectMenuOpen(projectName: string): boolean {
  return openProjectMenuId.value === projectName
}

function closeProjectMenu(): void {
  projectContextPoint.value = null
  openProjectMenuId.value = ''
}

function toggleOrganizeMenu(): void {
  const nextValue = !isOrganizeMenuOpen.value
  if (nextValue) {
    closeProjectMenu()
    closeThreadMenu()
  }
  isOrganizeMenuOpen.value = nextValue
}

function setThreadViewMode(mode: 'project' | 'chronological'): void {
  threadViewMode.value = mode
  isOrganizeMenuOpen.value = false
}

function toggleShowChatsFirst(): void {
  showChatsFirst.value = !showChatsFirst.value
}

function setChatSortMode(mode: ChatSortMode): void {
  chatSortMode.value = mode
}

function requestProjectGitStatusAndUpdateMenuDirection(projectName: string): void {
  emit('request-project-git-status', projectName)
  nextTick(() => {
    updateProjectMenuDirection(projectName)
  })
}

function toggleProjectMenu(projectName: string): void {
  projectContextPoint.value = null
  if (openProjectMenuId.value === projectName) {
    closeProjectMenu()
    return
  }

  closeThreadMenu()
  isOrganizeMenuOpen.value = false
  openProjectMenuId.value = projectName
  requestProjectGitStatusAndUpdateMenuDirection(projectName)
}

function openProjectContextMenu(event: MouseEvent, projectName: string): void {
  closeThreadMenu()
  projectContextPoint.value = { x: event.clientX, y: event.clientY }
  isOrganizeMenuOpen.value = false
  openProjectMenuId.value = projectName
  requestProjectGitStatusAndUpdateMenuDirection(projectName)
}

function openRenameProjectMenu(group: UiProjectGroup): void {
  emit('edit-project', group.projectName)
  closeProjectMenu()
}

function onBrowseProjectFiles(projectName: string): void {
  emit('browse-project-files', projectName)
  closeProjectMenu()
}

function onSaveProject(projectName: string): void {
  emit('save-project', projectName)
  closeProjectMenu()
}

function onCreateProjectWorktree(projectName: string): void {
  emit('create-project-worktree', projectName)
  closeProjectMenu()
}

function onProjectHeaderKeyDown(event: KeyboardEvent, projectName: string): void {
  if (event.target !== event.currentTarget) return
  if (!event.altKey) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return

  const currentIndex = props.groups.findIndex((group) => group.projectName === projectName)
  if (currentIndex < 0) return

  const delta = event.key === 'ArrowUp' ? -1 : 1
  const targetIndex = Math.max(0, Math.min(currentIndex + delta, props.groups.length - 1))
  if (targetIndex === currentIndex) return

  event.preventDefault()
  emit('reorder-project', {
    projectName,
    toIndex: targetIndex,
  })
}

function isExpanded(projectName: string): boolean {
  return expandedProjects.value[projectName] === true
}

function isCollapsed(projectName: string): boolean {
  return collapsedProjects.value[projectName] === true
}

const canCollapseProjectTree = computed(() => (
  isProjectsSectionExpanded.value && props.groups.some(group => !isCollapsed(group.projectName))
))

function toggleAllProjectLevels(): void {
  if (isSearchActive.value || isChronologicalView.value || props.groups.length === 0) return

  const collapse = canCollapseProjectTree.value
  const collapsed = { ...collapsedProjects.value }
  const expanded = { ...expandedProjects.value }
  for (const group of props.groups) {
    collapsed[group.projectName] = collapse
    expanded[group.projectName] = !collapse
  }
  collapsedProjects.value = collapsed
  expandedProjects.value = expanded
  isProjectsSectionExpanded.value = true
}

function toggleProjectExpansion(projectName: string): void {
  expandedProjects.value = {
    ...expandedProjects.value,
    [projectName]: !isExpanded(projectName),
  }
}

function toggleChatsListExpansion(): void {
  isChatsListExpanded.value = !isChatsListExpanded.value
}

function toggleProjectCollapse(projectName: string): void {
  if (suppressNextProjectToggleId.value === projectName) {
    suppressNextProjectToggleId.value = ''
    return
  }

  collapsedProjects.value = {
    ...collapsedProjects.value,
    [projectName]: !isCollapsed(projectName),
  }
}

function getProjectOuterHeight(projectName: string): number {
  const measuredHeight = measuredHeightByProject.value[projectName] ?? 0
  const drag = activeProjectDrag.value
  const dragHeight = drag?.projectName === projectName ? drag.groupHeight : null
  const baseHeight = dragHeight ?? measuredHeight
  const gap = isCollapsed(projectName) ? 0 : PROJECT_GROUP_EXPANDED_GAP_PX
  return Math.max(0, baseHeight + gap)
}

function setProjectMenuWrapRef(projectName: string, handle: ProjectMenuHandle | null): void {
  if (handle) {
    projectMenuHandleByName.set(projectName, handle)
    return
  }

  projectMenuHandleByName.delete(projectName)
}

function setThreadMenuWrapRef(threadId: string, element: Element | ComponentPublicInstance | null): void {
  const htmlElement =
    element instanceof HTMLElement
      ? element
      : element && '$el' in element && element.$el instanceof HTMLElement
        ? element.$el
        : null

  if (htmlElement) {
    threadMenuWrapElementById.set(threadId, htmlElement)
    return
  }

  threadMenuWrapElementById.delete(threadId)
}

function findMenuBoundaryRect(element: HTMLElement): DOMRect {
  let parent: HTMLElement | null = element.parentElement
  while (parent) {
    const styles = window.getComputedStyle(parent)
    const overflowY = styles.overflowY || styles.overflow
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden' || overflowY === 'clip') {
      return parent.getBoundingClientRect()
    }
    parent = parent.parentElement
  }

  return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

function resolveMenuDirection(menuWrapElement: HTMLElement, panelHeight: number): MenuDirection {
  const wrapRect = menuWrapElement.getBoundingClientRect()
  const boundaryRect = findMenuBoundaryRect(menuWrapElement)
  const panelGap = 6
  const spaceBelow = boundaryRect.bottom - wrapRect.bottom
  const spaceAbove = wrapRect.top - boundaryRect.top

  if (spaceBelow >= panelHeight + panelGap) return 'down'
  if (spaceAbove > spaceBelow) return 'up'
  return 'down'
}

function updateThreadMenuDirection(threadId: string, panelHeight: number): MenuDirection {
  const menuWrapElement = threadMenuWrapElementById.get(threadId)
  if (!menuWrapElement) return 'down'

  const direction = resolveMenuDirection(menuWrapElement, panelHeight)

  threadMenuDirectionById.value = {
    ...threadMenuDirectionById.value,
    [threadId]: direction,
  }
  return direction
}

function getThreadMenuDirection(threadId: string): MenuDirection {
  return threadMenuDirectionById.value[threadId] ?? 'down'
}

function updateProjectMenuDirection(projectName: string): void {
  const handle = projectMenuHandleByName.get(projectName)
  if (!handle) return

  projectMenuDirectionById.value = {
    ...projectMenuDirectionById.value,
    [projectName]: resolveMenuDirection(handle.element, handle.getPanelHeight()),
  }
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue)
}

function updateOpenThreadMenuPlacement(threadId: string): void {
  const menuWrapElement = threadMenuWrapElementById.get(threadId)
  if (!menuWrapElement) return

  const panelElement = openThreadMenuPanelRef.value
  const panelRect = panelElement?.getBoundingClientRect()
  const panelHeight = panelRect?.height || panelElement?.offsetHeight || 112
  const panelWidth = panelRect?.width || panelElement?.offsetWidth || 160
  if (threadContextPoint.value) {
    openThreadMenuStyle.value = positionPopover({
      anchor: menuWrapElement.getBoundingClientRect(),
      point: threadContextPoint.value,
      width: panelWidth,
      height: panelHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      direction: 'down',
      align: 'start',
    })
    return
  }
  const direction = updateThreadMenuDirection(threadId, panelHeight)
  const wrapRect = menuWrapElement.getBoundingClientRect()
  const viewportGap = 8
  const offset = 4
  const maxLeft = Math.max(viewportGap, window.innerWidth - panelWidth - viewportGap)
  const left = clamp(wrapRect.right - panelWidth, viewportGap, maxLeft)
  const top =
    direction === 'up'
      ? clamp(wrapRect.top - panelHeight - offset, viewportGap, Math.max(viewportGap, window.innerHeight - panelHeight - viewportGap))
      : clamp(wrapRect.bottom + offset, viewportGap, Math.max(viewportGap, window.innerHeight - panelHeight - viewportGap))

  openThreadMenuStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
  }
}

function onThreadMenuViewportChange(): void {
  const threadId = openThreadMenuId.value
  if (!threadId) return
  updateOpenThreadMenuPlacement(threadId)
}

function bindThreadMenuPositionListeners(): void {
  window.addEventListener('resize', onThreadMenuViewportChange)
  document.addEventListener('scroll', onThreadMenuViewportChange, true)
}

function unbindThreadMenuPositionListeners(): void {
  window.removeEventListener('resize', onThreadMenuViewportChange)
  document.removeEventListener('scroll', onThreadMenuViewportChange, true)
}

function isEventInsideOpenProjectMenu(event: Event): boolean {
  const projectName = openProjectMenuId.value
  if (!projectName) return false

  const openMenuWrapElement = projectMenuHandleByName.get(projectName)?.element
  if (!openMenuWrapElement) return false

  const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : []
  if (eventPath.includes(openMenuWrapElement)) return true

  const target = event.target
  return target instanceof Node ? isOverlayEventInside(event, openMenuWrapElement) : false
}

function isEventInsideOpenThreadMenu(event: Event): boolean {
  const threadId = openThreadMenuId.value
  if (!threadId) return false

  const openMenuWrapElement = threadMenuWrapElementById.get(threadId)
  if (!openMenuWrapElement) return false

  const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : []
  if (eventPath.includes(openMenuWrapElement)) return true

  const panelElement = openThreadMenuPanelRef.value
  if (panelElement && eventPath.includes(panelElement)) return true

  const target = event.target
  if (!(target instanceof Node)) return false
  if (isOverlayEventInside(event, openMenuWrapElement)) return true
  if (panelElement && isOverlayEventInside(event, panelElement)) return true
  return false
}

function onProjectMenuPointerDown(event: PointerEvent): void {
  if (isOrganizeMenuOpen.value) {
    const organizeElement = organizeMenuWrapRef.value
    const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : []
    const isInsideOrganizeMenu =
      !!organizeElement &&
      (eventPath.includes(organizeElement) || (event.target instanceof Node && organizeElement.contains(event.target)))

    if (!isInsideOrganizeMenu) {
      isOrganizeMenuOpen.value = false
    }
  }

  if (openProjectMenuId.value && !isEventInsideOpenProjectMenu(event)) {
    closeProjectMenu()
  }

  if (!openThreadMenuId.value) return
  if (isEventInsideOpenThreadMenu(event)) return
  closeThreadMenu()
}

function onProjectMenuFocusIn(event: FocusEvent): void {
  if (openProjectMenuId.value && !isEventInsideOpenProjectMenu(event)) {
    closeProjectMenu()
  }
  if (openThreadMenuId.value && !isEventInsideOpenThreadMenu(event)) {
    closeThreadMenu()
  }
}

function onWindowBlurForProjectMenu(): void {
  if (isOrganizeMenuOpen.value) {
    isOrganizeMenuOpen.value = false
  }
  if (openProjectMenuId.value) {
    closeProjectMenu()
  }
  if (openThreadMenuId.value) {
    closeThreadMenu()
  }
}

function bindProjectMenuDismissListeners(): void {
  window.addEventListener('pointerdown', onProjectMenuPointerDown, { capture: true })
  window.addEventListener('focusin', onProjectMenuFocusIn, { capture: true })
  window.addEventListener('blur', onWindowBlurForProjectMenu)
}

function unbindProjectMenuDismissListeners(): void {
  window.removeEventListener('pointerdown', onProjectMenuPointerDown, { capture: true })
  window.removeEventListener('focusin', onProjectMenuFocusIn, { capture: true })
  window.removeEventListener('blur', onWindowBlurForProjectMenu)
}

function updateMeasuredProjectHeight(projectName: string, element: HTMLElement): void {
  const nextHeight = element.getBoundingClientRect().height
  if (!Number.isFinite(nextHeight) || nextHeight <= 0) return

  const previousHeight = measuredHeightByProject.value[projectName]
  if (previousHeight !== undefined && Math.abs(previousHeight - nextHeight) < 0.5) {
    return
  }

  measuredHeightByProject.value = {
    ...measuredHeightByProject.value,
    [projectName]: nextHeight,
  }
}

function setProjectGroupRef(projectName: string, element: Element | ComponentPublicInstance | null): void {
  const previousElement = projectGroupElementByName.get(projectName)
  if (previousElement && previousElement !== element && projectGroupResizeObserver) {
    projectGroupResizeObserver.unobserve(previousElement)
  }

  const htmlElement =
    element instanceof HTMLElement
      ? element
      : element && '$el' in element && element.$el instanceof HTMLElement
        ? element.$el
        : null

  if (htmlElement) {
    projectGroupElementByName.set(projectName, htmlElement)
    projectNameByElement.set(htmlElement, projectName)
    updateMeasuredProjectHeight(projectName, htmlElement)
    projectGroupResizeObserver?.observe(htmlElement)
    return
  }

  if (previousElement) {
    projectGroupResizeObserver?.unobserve(previousElement)
  }

  projectGroupElementByName.delete(projectName)
}

function onProjectHandleMouseDown(event: MouseEvent, projectName: string): void {
  if (event.button !== 0) return
  if (isSearchActive.value || isStatusFilterActive.value) return
  if (pendingProjectDrag.value || activeProjectDrag.value) return

  const fromIndex = props.groups.findIndex((group) => group.projectName === projectName)
  const projectGroupElement = projectGroupElementByName.get(projectName)
  if (fromIndex < 0 || !projectGroupElement) return

  const groupRect = projectGroupElement.getBoundingClientRect()
  const groupGap = isCollapsed(projectName) ? 0 : PROJECT_GROUP_EXPANDED_GAP_PX
  pendingProjectDrag.value = {
    projectName,
    fromIndex,
    startClientX: event.clientX,
    startClientY: event.clientY,
    pointerOffsetY: event.clientY - groupRect.top,
    groupLeft: groupRect.left,
    groupWidth: groupRect.width,
    groupHeight: groupRect.height,
    groupOuterHeight: groupRect.height + groupGap,
  }

  event.preventDefault()
  bindProjectDragListeners()
}

function bindProjectDragListeners(): void {
  window.addEventListener('mousemove', onProjectDragMouseMove)
  window.addEventListener('mouseup', onProjectDragMouseUp)
  window.addEventListener('keydown', onProjectDragKeyDown)
}

function unbindProjectDragListeners(): void {
  window.removeEventListener('mousemove', onProjectDragMouseMove)
  window.removeEventListener('mouseup', onProjectDragMouseUp)
  window.removeEventListener('keydown', onProjectDragKeyDown)
}

function onProjectDragMouseMove(event: MouseEvent): void {
  pendingDragPointerSample = {
    clientX: event.clientX,
    clientY: event.clientY,
  }
  scheduleProjectDragPointerFrame()
}

function onProjectDragMouseUp(event: MouseEvent): void {
  processProjectDragPointerSample({
    clientX: event.clientX,
    clientY: event.clientY,
  })

  const drag = activeProjectDrag.value
  if (drag && projectedDropProjectIndex.value !== null) {
    const currentProjectIndex = props.groups.findIndex((group) => group.projectName === drag.projectName)
    if (currentProjectIndex >= 0) {
      const toIndex = projectedDropProjectIndex.value
      if (toIndex !== currentProjectIndex) {
        emit('reorder-project', {
          projectName: drag.projectName,
          toIndex,
        })
      }
    }
  }

  resetProjectDragState({ preserveToggleSuppression: Boolean(drag) })
}

function onProjectDragKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (!pendingProjectDrag.value && !activeProjectDrag.value) return

  event.preventDefault()
  resetProjectDragState()
}

function resetProjectDragState(options: { preserveToggleSuppression?: boolean } = {}): void {
  if (dragPointerRafId !== null) {
    window.cancelAnimationFrame(dragPointerRafId)
    dragPointerRafId = null
  }
  pendingDragPointerSample = null
  pendingProjectDrag.value = null
  activeProjectDrag.value = null
  if (!options.preserveToggleSuppression) {
    suppressNextProjectToggleId.value = ''
  }
  unbindProjectDragListeners()
}

function scheduleProjectDragPointerFrame(): void {
  if (dragPointerRafId !== null) return

  dragPointerRafId = window.requestAnimationFrame(() => {
    dragPointerRafId = null
    if (!pendingDragPointerSample) return

    const sample = pendingDragPointerSample
    pendingDragPointerSample = null
    processProjectDragPointerSample(sample)
  })
}

function processProjectDragPointerSample(sample: DragPointerSample): void {
  const pending = pendingProjectDrag.value
  if (!activeProjectDrag.value && pending) {
    const deltaX = sample.clientX - pending.startClientX
    const deltaY = sample.clientY - pending.startClientY
    const distance = Math.hypot(deltaX, deltaY)
    if (distance < DRAG_START_THRESHOLD_PX) {
      return
    }

    closeProjectMenu()
    suppressNextProjectToggleId.value = pending.projectName
    activeProjectDrag.value = {
      projectName: pending.projectName,
      fromIndex: pending.fromIndex,
      pointerOffsetY: pending.pointerOffsetY,
      groupLeft: pending.groupLeft,
      groupWidth: pending.groupWidth,
      groupHeight: pending.groupHeight,
      groupOuterHeight: pending.groupOuterHeight,
      ghostTop: sample.clientY - pending.pointerOffsetY,
      dropTargetIndexFull: null,
    }
  }

  if (!activeProjectDrag.value) return
  updateProjectDropTarget(sample)
}

function updateProjectDropTarget(sample: DragPointerSample): void {
  const drag = activeProjectDrag.value
  if (!drag) return

  drag.ghostTop = sample.clientY - drag.pointerOffsetY
  if (!isPointerInProjectDropZone(sample)) {
    drag.dropTargetIndexFull = null
    return
  }

  const cursorY = sample.clientY
  const groupsContainer = groupsContainerRef.value
  if (!groupsContainer) {
    drag.dropTargetIndexFull = null
    return
  }

  const containerRect = groupsContainer.getBoundingClientRect()
  const projectIndexByName = new Map(props.groups.map((group, index) => [group.projectName, index]))
  const nonDraggedProjectNames = props.groups
    .map((group) => group.projectName)
    .filter((projectName) => projectName !== drag.projectName)

  let accumulatedTop = 0
  let nextDropTarget = props.groups.length

  for (const projectName of nonDraggedProjectNames) {
    const originalIndex = projectIndexByName.get(projectName)
    if (originalIndex === undefined) continue

    const groupOuterHeight = getProjectOuterHeight(projectName)
    const groupMiddleY = containerRect.top + accumulatedTop + groupOuterHeight / 2
    if (cursorY < groupMiddleY) {
      nextDropTarget = originalIndex
      break
    }

    accumulatedTop += groupOuterHeight
  }

  drag.dropTargetIndexFull = nextDropTarget
}

function isPointerInProjectDropZone(sample: DragPointerSample): boolean {
  const groupsContainer = groupsContainerRef.value
  if (!groupsContainer) return false

  const bounds = groupsContainer.getBoundingClientRect()
  const xInBounds = sample.clientX >= bounds.left && sample.clientX <= bounds.right
  const yInBounds = sample.clientY >= bounds.top - 32 && sample.clientY <= bounds.bottom + 32
  return xInBounds && yInBounds
}

function isDraggingProject(projectName: string): boolean {
  return activeProjectDrag.value?.projectName === projectName
}

function projectGroupStyle(projectName: string): Record<string, string> | undefined {
  const drag = activeProjectDrag.value
  const targetTop = layoutTopByProject.value[projectName] ?? 0
  const openThreadMenuProjectName = openThreadMenuId.value
    ? (threadProjectNameById.value.get(openThreadMenuId.value) ?? '')
    : ''
  const shouldElevateForMenu =
    openProjectMenuId.value === projectName || openThreadMenuProjectName === projectName

  if (!drag || drag.projectName !== projectName) {
    return {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      zIndex: shouldElevateForMenu ? '40' : '1',
      transform: `translate3d(0, ${targetTop}px, 0)`,
      willChange: 'transform',
      transition: 'transform 180ms ease',
    }
  }

  return {
    position: 'fixed',
    top: '0',
    left: `${drag.groupLeft}px`,
    width: `${drag.groupWidth}px`,
    height: `${drag.groupHeight}px`,
    zIndex: '50',
    pointerEvents: 'none',
    transform: `translate3d(0, ${drag.ghostTop}px, 0)`,
    willChange: 'transform',
    transition: 'transform 0ms linear',
  }
}

function projectThreads(group: UiProjectGroup): UiThread[] {
  if (isSearchActive.value) return group.threads.filter(thread => !pinnedThreadIdSet.value.has(thread.id) && threadMatchesSearch(thread)).sort(compareSearchRank)
  return unpinnedThreadsByProjectName.value.get(group.projectName) ?? []
}

function visibleThreads(group: UiProjectGroup): UiThread[] {
  if (isSearchActive.value) return projectThreads(group)
  if (isCollapsed(group.projectName)) return []

  const rows = projectThreads(group)
  return isExpanded(group.projectName) ? rows : rows.slice(0, 10)
}

function hasHiddenThreads(group: UiProjectGroup): boolean {
  if (isSearchActive.value) return false
  return !isCollapsed(group.projectName) && projectThreads(group).length > 10
}

function hasThreads(group: UiProjectGroup): boolean {
  return projectThreads(group).length > 0
}

function shouldShowThreadIndicator(thread: UiThread): boolean {
  return Boolean(thread.pendingRequestState) || thread.inProgress || thread.unread || thread.backgroundCompleted === true || Boolean(threadInterruptionDot(thread))
}

function threadRequestLabel(thread: UiThread): string {
  return thread.pendingRequestState === 'approval' ? t('Awaiting approval') : t('Awaiting response')
}

function threadInterruptionDot(thread: UiThread): ThreadInterruption['kind'] | undefined {
  return problemDot(props.interruptions?.[thread.id])
}

function threadIndicatorTitle(thread: UiThread): string | undefined {
  if (thread.inProgress || thread.pendingRequestState) return undefined
  const kind = threadInterruptionDot(thread)
  return kind === 'quota' ? t('额度不足') : kind === 'error' ? t('会话异常中断') : thread.backgroundCompleted ? t('后台任务已完成') : undefined
}

function getThreadState(thread: UiThread): 'awaiting-approval' | 'awaiting-response' | 'working' | 'unread' | 'background-completed' | 'idle' | ThreadInterruption['kind'] {
  if (thread.pendingRequestState === 'approval') return 'awaiting-approval'
  if (thread.pendingRequestState === 'response') return 'awaiting-response'
  if (thread.inProgress) return 'working'
  const interruption = threadInterruptionDot(thread)
  if (interruption) return interruption
  if (thread.unread) return 'unread'
  if (thread.backgroundCompleted) return 'background-completed'
  return 'idle'
}

watch(
  () => props.groups.map((group) => group.projectName),
  (projectNames) => {
    const dragProjectName = activeProjectDrag.value?.projectName ?? pendingProjectDrag.value?.projectName ?? ''
    if (dragProjectName && !props.groups.some((group) => group.projectName === dragProjectName)) {
      resetProjectDragState()
    }

    const projectNameSet = new Set(projectNames)
    const nextMeasuredHeights = Object.fromEntries(
      Object.entries(measuredHeightByProject.value).filter(([projectName]) => projectNameSet.has(projectName)),
    ) as Record<string, number>

    if (Object.keys(nextMeasuredHeights).length !== Object.keys(measuredHeightByProject.value).length) {
      measuredHeightByProject.value = nextMeasuredHeights
    }
  },
)

watch(
  () => {
    const projectName = openProjectMenuId.value
    return projectName ? props.projectGitRepoByName[projectName] : undefined
  },
  () => {
    const projectName = openProjectMenuId.value
    if (!projectName) return
    nextTick(() => {
      if (openProjectMenuId.value === projectName) {
        updateProjectMenuDirection(projectName)
      }
    })
  },
)

const hasOpenDismissableMenu = computed(
  () => isOrganizeMenuOpen.value || openProjectMenuId.value !== '' || openThreadMenuId.value !== '',
)

watch(hasOpenDismissableMenu, (isOpen) => {
  if (isOpen) {
    bindProjectMenuDismissListeners()
    return
  }

  unbindProjectMenuDismissListeners()
})

watch(openThreadMenuId, (threadId) => {
  if (!threadId) {
    unbindThreadMenuPositionListeners()
    return
  }

  bindThreadMenuPositionListeners()
  nextTick(() => {
    updateOpenThreadMenuPlacement(threadId)
  })
})

onBeforeUnmount(() => {
  sidebarStopped = true
  pinnedThreadHydrationVersion += 1
  cancelAnimationFrame(projectMeasureFrame)
  pendingProjectMeasurements.clear()
  for (const element of projectGroupElementByName.values()) {
    projectGroupResizeObserver?.unobserve(element)
  }
  projectGroupElementByName.clear()
  projectMenuHandleByName.clear()
  unbindThreadMenuPositionListeners()
  unbindProjectMenuDismissListeners()
  resetProjectDragState()
})
</script>

<style scoped>
@reference "tailwindcss";

.thread-tree-root {
  @apply flex flex-col;
}

.pinned-section {
  @apply order-1 mb-1;
}

.projects-section {
  @apply order-2;
}

.chats-section {
  @apply order-3 mt-1;
}

.thread-tree-root.chats-first .chats-section {
  @apply order-2;
}

.thread-tree-root.chats-first .projects-section {
  @apply order-3;
}

.thread-tree-header-row {
  @apply cursor-pointer;
}

.section-toggle-row {
  @apply hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400;
}

.thread-tree-header {
  @apply text-sm font-normal text-zinc-500 select-none;
}

.chats-section-actions {
  @apply flex items-center gap-1;
}

.chats-section-action {
  @apply h-5 w-5 rounded text-zinc-500 flex items-center justify-center transition hover:bg-zinc-200 hover:text-zinc-700;
}

.chats-section-action[aria-pressed='true'] {
  @apply bg-zinc-200 text-zinc-800;
}

.projects-header-actions {
  @apply flex items-center gap-1;
}

.projects-header-actions .organize-menu-trigger {
  @apply w-4;
}

.project-tree-toggle {
  @apply h-5 w-5 rounded flex items-center justify-center;
  color: var(--ui-muted);
}

.project-tree-toggle:hover:not(:disabled) {
  background: var(--ui-hover);
  color: var(--ui-text);
}

.project-tree-toggle:focus-visible {
  outline: 2px solid var(--ui-focus);
  outline-offset: 2px;
}

.project-tree-toggle:disabled {
  opacity: 0.4;
}

.organize-menu-wrap {
  @apply relative;
}

.organize-menu-trigger {
  @apply h-5 w-5 rounded text-zinc-500 flex items-center justify-center transition hover:bg-zinc-200 hover:text-zinc-700;
}

.organize-menu-panel {
  @apply absolute right-0 top-full mt-1 z-30 min-w-44 rounded-xl border border-zinc-200 bg-white/95 p-1.5 shadow-lg backdrop-blur-sm;
}

.organize-menu-title {
  @apply px-2 py-1 text-xs text-zinc-500;
}

.organize-menu-separator {
  @apply my-1 h-px bg-zinc-200;
}

.organize-menu-item {
  @apply w-full rounded-lg px-2 py-1.5 text-sm text-zinc-700 flex items-center justify-between hover:bg-zinc-100;
}

.organize-menu-item[data-active='true'] {
  @apply bg-zinc-100 text-zinc-900;
}

.thread-start-button {
  @apply h-5 w-5 rounded text-zinc-500 flex items-center justify-center transition hover:bg-zinc-200 hover:text-zinc-700;
}

.thread-tree-loading {
  @apply px-3 py-2 text-sm text-zinc-500;
}

.thread-tree-no-results {
  @apply px-3 py-2 text-sm text-zinc-400;
}

.thread-tree-action-error {
  @apply mx-2 my-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700;
}

.thread-tree-groups {
  @apply pr-0.5 relative;
}

.project-group {
  @apply m-0 transition-shadow;
}

.project-group[data-dragging='true'] {
  @apply shadow-lg;
}

.project-header-row {
  @apply hover:bg-zinc-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400;
}

.project-main-button {
  @apply min-w-0 w-full text-left rounded px-0 py-0 flex items-center gap-1.5 min-h-5 cursor-grab;
}

.project-main-button[data-dragging-handle='true'] {
  @apply cursor-grabbing;
}

.project-icon-stack {
  @apply relative w-4 h-4 flex items-center justify-center text-zinc-500;
}

.project-icon-folder {
  @apply absolute inset-0 flex items-center justify-center opacity-100;
}

.project-icon-chevron {
  @apply absolute inset-0 items-center justify-center opacity-0 hidden;
}

.project-title {
  @apply min-w-0 flex-1 text-sm font-normal text-zinc-700 truncate select-none;
}







.project-empty-row {
  @apply cursor-default;
}

.project-empty-spacer {
  @apply block w-4 h-4;
}

.project-empty {
  @apply text-sm text-zinc-400;
}

.thread-list {
  @apply list-none m-0 p-0 flex flex-col gap-0.5;
}

.thread-list-global {
  @apply pr-0.5;
}

.project-group > .thread-list {
  @apply mt-0.5;
}

.thread-menu-panel {
  @apply absolute right-0 top-full mt-1 z-20 min-w-36 rounded-md border border-zinc-200 bg-white p-1 shadow-md flex flex-col gap-0.5;
}

.thread-menu-panel-fixed {
  @apply fixed top-0 right-auto bottom-auto left-0 mt-0 z-50 overflow-y-auto;
}

.thread-menu-panel:not(.thread-menu-panel-fixed)[data-open-direction='up'] {
  top: auto;
  bottom: calc(100% + 0.25rem);
  margin-top: 0;
}

.thread-menu-item {
  @apply rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100;
}

.thread-menu-item:disabled {
  @apply cursor-not-allowed text-zinc-400 hover:bg-transparent;
}

.thread-menu-item-danger {
  @apply text-rose-700 hover:bg-rose-50;
}

.thread-icon {
  @apply w-4 h-4;
}

.thread-show-more-row {
  @apply mt-1;
}

.thread-show-more-spacer {
  @apply block w-4 h-4;
}

.thread-show-more-button {
  @apply block mx-auto rounded-lg px-2 py-0.5 text-sm font-normal text-zinc-600 transition hover:text-zinc-800 hover:bg-zinc-200;
}

.project-header-row:hover .project-icon-folder {
  @apply opacity-0;
}

.project-header-row:hover .project-icon-chevron {
  @apply flex opacity-100;
}

.rename-thread-overlay {
  @apply fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4;
}

.rename-thread-panel {
  @apply w-full max-w-sm rounded-xl bg-white p-4 shadow-xl
         max-h-[90vh] flex flex-col overflow-hidden;
}

.rename-thread-title {
  @apply m-0 text-base font-semibold text-zinc-900 shrink-0;
}

.rename-thread-subtitle {
  @apply mt-1 mb-3 text-sm text-zinc-500 overflow-y-auto flex-1 min-h-0 min-w-0 break-words;
}

.rename-thread-input {
  @apply w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 shrink-0;
}

.rename-thread-actions {
  @apply mt-3 flex items-center justify-end gap-2 shrink-0;
}

.automation-thread-panel {
  @apply max-w-lg overflow-y-auto;
  max-height: min(90vh, calc(100dvh - 2rem));
  overscroll-behavior: contain;
}

.automation-thread-panel .rename-thread-subtitle {
  @apply flex-none overflow-visible;
}

.automation-thread-panel .rename-thread-actions {
  @apply sticky bottom-0 -mx-4 -mb-4 border-t border-zinc-200 bg-white px-4 py-3;
}

:global(:root.dark) .automation-thread-panel .rename-thread-actions {
  @apply border-zinc-700 bg-zinc-800;
}

.automation-thread-field {
  @apply mb-3 flex flex-col gap-1;
}

.automation-target-picker {
  @apply mb-3 flex flex-col gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2;
}

.automation-target-mode-group {
  @apply grid grid-cols-2 gap-1 rounded-lg border border-zinc-200 bg-white p-1;
}

.automation-target-mode {
  @apply rounded-md px-2 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100;
}

.automation-target-mode.is-active {
  @apply bg-zinc-900 text-white shadow-sm hover:bg-zinc-900;
}

.automation-target-dropdown {
  @apply flex flex-col gap-2;
}

.automation-thread-label {
  @apply text-xs font-medium uppercase tracking-wide text-zinc-500;
}

.automation-thread-textarea {
  @apply w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500;
}

.automation-thread-dropdown :deep(.composer-dropdown-trigger) {
  @apply w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900;
}

.automation-thread-dropdown :deep(.composer-dropdown-value) {
  @apply min-w-0 flex-1 text-left;
}

.automation-schedule-mode-group {
  @apply grid grid-cols-3 gap-1 rounded-lg border border-zinc-200 bg-zinc-100 p-1;
}

.automation-schedule-mode {
  @apply rounded-md px-2 py-1.5 text-xs font-medium text-zinc-600 hover:bg-white;
}

.automation-schedule-mode.is-active {
  @apply bg-white text-zinc-950 shadow-sm;
}

.automation-schedule-row {
  @apply mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2;
}

.automation-schedule-copy {
  @apply text-sm text-zinc-600;
}

.automation-schedule-time,
.automation-schedule-number,
.automation-schedule-unit {
  @apply rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500;
}

.automation-schedule-unit-dropdown :deep(.composer-dropdown-trigger) {
  @apply min-h-8 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900;
}

.automation-schedule-number {
  @apply w-20;
}

.automation-schedule-preview {
  @apply mt-1 text-xs text-zinc-500;
}

.automation-thread-error {
  @apply mb-0 text-rose-600;
}

.automation-thread-notice {
  @apply mb-0 text-emerald-600;
}

@media (max-height: 640px) {
  .automation-thread-panel {
    @apply p-3;
  }

  .automation-thread-panel .rename-thread-actions {
    @apply -mx-3 -mb-3 px-3 py-2;
  }

  .automation-thread-field,
  .automation-target-picker {
    @apply mb-2;
  }

  .automation-thread-textarea {
    min-height: 7rem;
  }
}
</style>
