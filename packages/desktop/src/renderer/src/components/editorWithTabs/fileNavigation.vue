<template>
  <div
    v-if="canNavigate"
    class="file-navigation"
  >
    <el-button
      :title="'Previous file'"
      :aria-label="'Previous file'"
      circle
      @click="goToAdjacentFile(-1)"
    >
      <el-icon>
        <ArrowUp />
      </el-icon>
    </el-button>
    <el-button
      :title="'Next file'"
      :aria-label="'Next file'"
      circle
      @click="goToAdjacentFile(1)"
    >
      <el-icon>
        <ArrowDown />
      </el-icon>
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

const projectFiles = computed(() => (projectTree.value ? collectMarkdownFiles(projectTree.value) : []))

const currentProjectFileIndex = computed(() => {
  const pathname = currentFile.value?.pathname
  if (!pathname) return -1
  return projectFiles.value.findIndex((file) => window.fileUtils.isSamePathSync(file.pathname, pathname))
})

const canNavigate = computed(() => projectFiles.value.length > 1 && currentProjectFileIndex.value !== -1)

const closePreviousIfSaved = (previous: IFileState): void => {
  if (!previous.isSaved) return
  const stillOpen = tabs.value.find((tab) => tab.id === previous.id)
  if (stillOpen && stillOpen.id !== currentFile.value?.id) {
    editorStore.FORCE_CLOSE_TAB(stillOpen)
  }
}

const goToAdjacentFile = (direction: -1 | 1): void => {
  const currentIndex = currentProjectFileIndex.value
  if (currentIndex === -1) return

  const nextIndex =
    direction < 0
      ? (currentIndex - 1 + projectFiles.value.length) % projectFiles.value.length
      : (currentIndex + 1) % projectFiles.value.length
  const nextFile = projectFiles.value[nextIndex]
  if (!nextFile) return

  const previousFile = currentFile.value
  if (!previousFile) return

  const nextTab = tabs.value.find((tab) => window.fileUtils.isSamePathSync(tab.pathname, nextFile.pathname))
  if (!nextTab) {
    pendingCloseAfterOpen.value = {
      previous: previousFile,
      targetPathname: nextFile.pathname
    }
    window.electron.ipcRenderer.send('mt::open-file', nextFile.pathname, {})
    return
  }

  nextTab.scrollTop = 0
  editorStore.UPDATE_CURRENT_FILE(nextTab)
  closePreviousIfSaved(previousFile)
}

watch(
  () => currentFile.value?.pathname,
  (pathname) => {
    const pending = pendingCloseAfterOpen.value
    if (!pending || !pathname) return
    if (!window.fileUtils.isSamePathSync(pathname, pending.targetPathname)) return

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
  height: 34px;
  margin: 0;
  width: 34px;
}
</style>
