<template>
  <div
    v-if="canNavigate"
    class="file-navigation"
  >
    <el-button
      circle
      title="Previous file"
      aria-label="Previous file"
      @click="goToAdjacentFile(-1)"
    >
      <el-icon><ArrowUp /></el-icon>
    </el-button>
    <el-button
      circle
      title="Next file"
      aria-label="Next file"
      @click="goToAdjacentFile(1)"
    >
      <el-icon><ArrowDown /></el-icon>
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ArrowDown, ArrowUp } from '@element-plus/icons-vue'
import { useEditorStore } from '@/store/editor'
import { useProjectStore } from '@/store/project'
import type { TreeFileNode, TreeFolderNode } from '@/components/sideBar/types'
import type { IFileState } from '@shared/types/files'

const editorStore = useEditorStore()
const projectStore = useProjectStore()
const { currentFile, tabs } = storeToRefs(editorStore)
const { projectTree } = storeToRefs(projectStore)
const pendingCloseAfterOpen = ref<{ previous: IFileState; targetPathname: string } | null>(null)

const collectMarkdownFiles = (folder: TreeFolderNode): TreeFileNode[] => [
  ...folder.folders.flatMap(collectMarkdownFiles),
  ...folder.files.filter((file) => file.isMarkdown)
]
const projectFiles = computed(() =>
  projectTree.value ? collectMarkdownFiles(projectTree.value) : []
)
const currentIndex = computed(() => {
  const pathname = currentFile.value?.pathname
  return pathname
    ? projectFiles.value.findIndex((file) =>
      window.fileUtils.isSamePathSync(file.pathname, pathname)
    )
    : -1
})
const canNavigate = computed(() => projectFiles.value.length > 1 && currentIndex.value >= 0)

const closePreviousIfSaved = (previous: IFileState): void => {
  if (!previous.isSaved) return
  const tab = tabs.value.find((candidate) => candidate.id === previous.id)
  if (tab && tab.id !== currentFile.value?.id) editorStore.FORCE_CLOSE_TAB(tab)
}

const goToAdjacentFile = (direction: -1 | 1): void => {
  const index = currentIndex.value
  const previous = currentFile.value
  if (index < 0 || !previous) return
  const target =
    projectFiles.value[(index + direction + projectFiles.value.length) % projectFiles.value.length]
  if (!target) return

  const existing = tabs.value.find((tab) =>
    window.fileUtils.isSamePathSync(tab.pathname, target.pathname)
  )
  if (existing) {
    existing.scrollTop = 0
    editorStore.UPDATE_CURRENT_FILE(existing)
    closePreviousIfSaved(previous)
    return
  }

  pendingCloseAfterOpen.value = { previous, targetPathname: target.pathname }
  window.electron.ipcRenderer.send('mt::open-file', target.pathname, {})
}

watch(
  () => currentFile.value?.pathname,
  (pathname) => {
    const pending = pendingCloseAfterOpen.value
    if (!pending || !pathname || !window.fileUtils.isSamePathSync(pathname, pending.targetPathname)) { return }
    pendingCloseAfterOpen.value = null
    closePreviousIfSaved(pending.previous)
  }
)
</script>

<style scoped>
.file-navigation {
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: absolute;
  right: 18px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
}
.file-navigation .el-button {
  width: 34px;
  height: 34px;
  margin: 0;
}
</style>
