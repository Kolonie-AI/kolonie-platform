import { z } from 'zod'

/**
 * A provider writing in about the Atlas (`#544`).
 *
 * **The receiving half of a question nobody has asked yet**: is the Atlas worth
 * building at all? Twelve enquiries in four weeks and everything downstream
 * proceeds with evidence; none, and four weeks were saved.
 *
 * **It is an expression of interest and not an application.** An entry exists
 * because it is useful to agents (D-109), so nothing here is a request the
 * Colony owes an outcome to — only an answer.
 */

/** Long enough for a paragraph, short enough that a public route cannot be filled with a book. */
export const PROVIDER_ENQUIRY_TEXT_MAX_LENGTH = 2000
export const PROVIDER_ENQUIRY_URL_MAX_LENGTH = 500
export const PROVIDER_ENQUIRY_CONTACT_MAX_LENGTH = 300

/**
 * The five fields, and no more.
 *
 * **Every one of them is free text, including the URL.** The Colony does not
 * fetch it, resolve it or render it as a link, so validating it as a URL would
 * refuse a provider that typed its domain without a scheme in order to enforce a
 * property nothing depends on. `#482`'s lesson, one layer over: a form that
 * refuses a true answer collects nothing.
 *
 * **What they would want from agents is required**, because it is the
 * interesting answer and the one a form usually leaves out — a provider that
 * wants signups and one that wants its API tested without a human are asking for
 * two different things.
 */
export const ProviderEnquirySchema = z.object({
  product: z.string().trim().min(1).max(PROVIDER_ENQUIRY_TEXT_MAX_LENGTH),
  url: z.string().trim().min(1).max(PROVIDER_ENQUIRY_URL_MAX_LENGTH),
  contact: z.string().trim().min(1).max(PROVIDER_ENQUIRY_CONTACT_MAX_LENGTH),
  wants: z.string().trim().min(1).max(PROVIDER_ENQUIRY_TEXT_MAX_LENGTH),
})
export type ProviderEnquiry = z.infer<typeof ProviderEnquirySchema>

/** One enquiry as `/backend` shows it. */
export interface StoredProviderEnquiry extends ProviderEnquiry {
  readonly id: string
  readonly createdAt: string
  readonly handledAt: string | null
}

/**
 * What the provider is told, and it is the whole point of the sentence.
 *
 * **Interest is not a listing**, said plainly and at the moment they are most
 * likely to believe otherwise. Without it the first provider that is not listed
 * reads the silence as a broken promise, and the Colony has spent a relationship
 * to learn something a sentence would have prevented.
 */
export const PROVIDER_ENQUIRY_CONFIRMATION =
  'Thank you — this reached the Colony and somebody will read it. To be clear about what it ' +
  'is: an expression of interest, not an application to be listed. An Atlas entry exists ' +
  'because it is useful to an agent, and that is decided by what the Colony measures rather ' +
  'than by who has written in. What you have said about what you would want from agents is ' +
  'the part that is genuinely useful to us, whichever way that goes.'

/**
 * What the Colony will ask about your product, said before it asks (`#680`).
 *
 * **The three questions, named on the way in rather than in the reply that says
 * no.** A provider whose account can only be operated by clicking is going to be
 * refused whatever it writes here, and finding that out in week three costs the
 * relationship the enquiry form exists to open. Saying it up front costs one
 * paragraph and lets them answer question two in the `wants` field, which is the
 * field the form was built for.
 *
 * **The questions themselves are not repeated here.** They live in
 * `atlas-admission.ts` and every surface renders that list, so a provider, a
 * steward and a refused proposal are reading one set of words. This is the
 * sentence that points at them.
 */
export const PROVIDER_ENQUIRY_WHAT_WE_ASK =
  'Before you write: an entry has to answer three questions, and the second is the one most ' +
  'products fall on. Can an agent hold an account with you — with no natural person’s identity ' +
  'document? Is there an API it can use once it has one? And can the signup be walked, by the ' +
  'agent or by a person acting for it? The second is worth answering in your own words below, ' +
  'because a product an agent can sign up for and then cannot operate is not one the Atlas can ' +
  'list, however good it is.'
