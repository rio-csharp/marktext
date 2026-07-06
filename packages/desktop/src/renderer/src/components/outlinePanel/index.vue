<template>
  <div
    v-show="showOutlinePanel"
    class="outline-panel"
    :style="{ width: `${outlinePanelWidth}px` }"
  >
    <toc v-if="showOutlinePanel" />
  </div>
</template>

<script setup lang="ts">
import { useLayoutStore } from '@/store/layout'
import Toc from '@/components/sideBar/toc.vue'
import { storeToRefs } from 'pinia'

const layoutStore = useLayoutStore()
const { showOutlinePanel, outlinePanelWidth } = storeToRefs(layoutStore)
</script>

<style scoped>
.outline-panel {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  flex-grow: 0;
  height: 100vh;
  min-width: 220px;
  position: relative;
  z-index: 1;
  color: var(--sideBarColor);
  user-select: none;
  background: var(--sideBarBgColor);
  border-left: 1px solid var(--itemBgColor);
  overflow: hidden;
}
</style>
