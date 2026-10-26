/**
 * A stand-in weather tool, so the stream carries tool events without a weather API.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

export const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: z.object({
    city: z.string().describe('Name of the city, for example Lisbon'),
  }),
  callback: async ({ city }) => {
    // Pretend to call a weather service, so the page shows the tool status for a moment.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return { city, temperatureC: 21, conditions: 'sunny' }
  },
})
