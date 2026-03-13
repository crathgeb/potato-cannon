import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Polyfill ResizeObserver for jsdom
if (!global.ResizeObserver) {
  global.ResizeObserver = class ResizeObserver {
    constructor(callback: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// Auto cleanup after each test
afterEach(() => {
  cleanup()
})
