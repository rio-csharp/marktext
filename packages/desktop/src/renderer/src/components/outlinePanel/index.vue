<template>
  <aside
    v-if="showOutlinePanel"
    class="outline-panel"
    :style="{ width: `${outlinePanelWidth}px` }"
    aria-label="Outline"
  >
    <div class="resize-handle" @mousedown="startResize" />
    <toc />
  </aside>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import Toc from '@/components/sideBar/toc.vue'
import { useLayoutStore } from '@/store/layout'

const layoutStore = useLayoutStore()
const { showOutlinePanel, outlinePanelWidth } = storeToRefs(layoutStore)
let startX = 0
let startWidth = 0

const handleMouseMove = (event: MouseEvent): void => {
  layoutStore.SET_OUTLINE_PANEL_WIDTH(startWidth + startX - event.clientX)
}
const stopResize = (): void => {
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', stopResize)
}
const startResize = (event: MouseEvent): void => {
  startX = event.clientX
  startWidth = outlinePanelWidth.value
  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', stopResize)
}
onBeforeUnmount(stopResize)
</script>

<style scoped>
.outline-panel {
  display: flex;
  flex: 0 0 auto;
  height: 100vh;
  min-width: 220px;
  position: relative;
  color: var(--sideBarColor);
  user-select: none;
  background: var(--sideBarBgColor);
  border-left: 1px solid var(--itemBgColor);
  overflow: hidden;
}
.resize-handle {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  z-index: 2;
  cursor: col-resize;
}
.outline-panel :deep(.side-bar-toc) {
  height: 100%;
  width: 100%;
}
</style>
