export const automaticResumeStartedMethod = 'thread/autoResume/started'
export type AutomaticResumeSource = 'quota' | 'scheduled'
export type AutomaticResumeStarted = {
  threadId: string
  deliveryId: string
  source: AutomaticResumeSource
  turnId?: string
}
