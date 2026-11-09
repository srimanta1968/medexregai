import { useEffect } from 'react';

export interface PageMeta {
  /** Page-specific title; the site name is appended. */
  title: string;
  /** One-sentence summary for search results and link previews. */
  description: string;
}

const SITE_NAME = 'MedexRegAI';

function setMetaTag(attribute: 'name' | 'property', key: string, content: string): void {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

/** Set the document title and description (plus Open Graph equivalents) for a page. */
export function usePageMeta({ title, description }: PageMeta): void {
  useEffect(() => {
    const fullTitle = title === SITE_NAME ? title : `${title} | ${SITE_NAME}`;
    document.title = fullTitle;
    setMetaTag('name', 'description', description);
    setMetaTag('property', 'og:title', fullTitle);
    setMetaTag('property', 'og:description', description);
    setMetaTag('property', 'og:site_name', SITE_NAME);
  }, [title, description]);
}
