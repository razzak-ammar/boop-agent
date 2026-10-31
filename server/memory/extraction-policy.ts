/** Skip only unmistakable social filler. Any substantive or unfamiliar text,
 * correction, personal detail, request, or image still gets the full extractor. */
export function shouldExtractMemory(userMessage: string, imageStorageIds?: string[]): boolean {
  if (imageStorageIds?.length) return true;
  return !/^(?:hi|hello|hey|thanks|thank you|thx|ok|okay|got it|sounds good)[\s!.]*$/i.test(userMessage.trim());
}
