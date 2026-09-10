import type { Component } from 'vue'

export type SelectOption = {
  value: string
  label: string
}

export type AppSelectProps = {
  modelValue: string
  options: SelectOption[]
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
  selectedPrefixIcon?: Component | null
  iconOnly?: boolean
  openDirection?: 'up' | 'down'
  menuAlign?: 'start' | 'end'
  enableSearch?: boolean
  searchPlaceholder?: string
  emptyLabel?: string
}
