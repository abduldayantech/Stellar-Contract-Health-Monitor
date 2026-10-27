import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExportLinks } from '@/components/export-links';

describe('ExportLinks', () => {
  it('links to the export endpoint with the current filters and no page size', () => {
    render(
      <ExportLinks query={{ contractRefId: 'c1', topic: 'transfer', limit: 50, txHash: '' }} />,
    );
    expect(screen.getByRole('link', { name: 'CSV' })).toHaveAttribute(
      'href',
      '/api/proxy/events/export?contractRefId=c1&topic=transfer&format=csv',
    );
    expect(screen.getByRole('link', { name: 'NDJSON' })).toHaveAttribute(
      'href',
      '/api/proxy/events/export?contractRefId=c1&topic=transfer&format=ndjson',
    );
  });
});
