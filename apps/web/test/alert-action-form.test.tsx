import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AlertActionForm } from '@/components/alert-action-form';

describe('AlertActionForm', () => {
  it('submits the trimmed note', async () => {
    const onSubmit = vi.fn(async () => {});
    render(
      <AlertActionForm alertId="a1" action="acknowledge" onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: '  Known issue  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge alert' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Known issue'));
  });

  it('allows an empty note and can be cancelled', async () => {
    const onSubmit = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(
      <AlertActionForm alertId="a1" action="resolve" onSubmit={onSubmit} onCancel={onCancel} />,
    );
    expect(screen.getByLabelText(/Note/)).toHaveAttribute('maxlength', '1000');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve alert' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(''));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
