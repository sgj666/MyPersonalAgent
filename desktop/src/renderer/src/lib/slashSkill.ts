// Slash skills: `/name rest` runs an installed skill.
//
// The backend has no `/skill <name>` command — a skill is chosen by the agent
// from its description. So a slash command that names a skill is expanded on
// the client into an instruction that names it explicitly, while the transcript
// keeps the line the teacher typed (chatStore.send's `display`).
import apiClient from '../api/client'
import { tf } from '../i18n'

export interface SlashSkill {
  name: string
  desc: string
}

let cache: Promise<SlashSkill[]> | null = null

/** The enabled skills, fetched once per app run. A failure is not fatal. */
export function loadSlashSkills(): Promise<SlashSkill[]> {
  if (!cache) {
    cache = apiClient
      .getSkills()
      .then((list) =>
        list
          .filter((skill) => skill.enabled)
          .map((skill) => ({
            name: skill.name,
            desc: (skill.display_description || skill.description || '').trim(),
          }))
      )
      .catch(() => {
        cache = null // a later attempt may succeed
        return []
      })
  }
  return cache
}

/** `/teaching-advice 看看七(3)班` → the instruction the agent receives. */
export function expandSkillSlash(text: string, skills: SlashSkill[]): string | null {
  const match = /^\/([a-z0-9][a-z0-9_-]*)\s*([\s\S]*)$/i.exec(text.trim())
  if (!match) return null
  const skill = skills.find((item) => item.name === match[1])
  if (!skill) return null
  const rest = match[2].trim()
  return tf('slash_use_skill', { name: skill.name }) + (rest ? `\n${rest}` : '')
}
