import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingRegion,
  ProgressBar,
  SegmentedControl,
  StaleNotice,
  Select,
  SwitchField,
  Textarea,
} from '@uxe/ui';

describe('Button', () => {
  it('calls its handler and reports its accessible name', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Start consultation</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Start consultation' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire while loading, and announces the busy state', async () => {
    const onClick = vi.fn();
    render(
      <Button loading loadingLabel="Uploading" onClick={onClick}>
        Upload
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByText('Uploading')).toBeInTheDocument();
  });

  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Delete
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders as a link when asChild is used, with no nested button', () => {
    render(
      <Button asChild>
        <a href="/knowledge">Open knowledge</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Open knowledge' });
    expect(link).toHaveAttribute('href', '/knowledge');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Field and Input', () => {
  it('associates the label, hint and error with the control', () => {
    render(
      <Field
        label="Work email"
        htmlFor="email"
        hint="Use your organisation address"
        error="Enter a valid email"
        required
      >
        <Input id="email" />
      </Field>,
    );

    const input = screen.getByLabelText(/Work email/);
    expect(input).toHaveAttribute('aria-invalid', 'true');

    const describedBy = (input.getAttribute('aria-describedby') ?? '').split(/\s+/);
    const described = describedBy.map((id) => document.getElementById(id)?.textContent).join(' ');
    expect(described).toContain('Enter a valid email');
    expect(described).toContain('Use your organisation address');
  });

  it('announces the error politely rather than silently colouring the border', () => {
    render(
      <Field label="Password" htmlFor="pw" error="Too short">
        <Input id="pw" type="password" />
      </Field>,
    );
    expect(screen.getByText('Too short')).toHaveAttribute('role', 'alert');
  });

  it('marks a required field for assistive technology, not only with an asterisk', () => {
    render(
      <Field label="Title" htmlFor="title" required>
        <Input id="title" />
      </Field>,
    );
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByLabelText(/^Title/)).toBeRequired();
  });

  it('accepts typed input', async () => {
    render(<Input aria-label="Search" />);
    await userEvent.type(screen.getByLabelText('Search'), 'egress');
    expect(screen.getByLabelText('Search')).toHaveValue('egress');
  });

  it('shows a live character count on a textarea with a limit', async () => {
    render(<Textarea aria-label="Question" maxLength={20} />);
    await userEvent.type(screen.getByLabelText('Question'), 'Is it compliant?');
    expect(screen.getByLabelText('Question')).toHaveValue('Is it compliant?');
  });
});

describe('SegmentedControl', () => {
  const OPTIONS = [
    { value: 'yes_no', label: 'Yes/No' },
    { value: 'optimal', label: 'Optimal' },
    { value: 'details', label: 'Details' },
  ];

  it('exposes the selected mode through aria-checked, not colour alone', () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="optimal"
        onValueChange={() => {}}
        ariaLabel="Answer style"
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Answer style' });
    expect(within(group).getByRole('radio', { name: 'Optimal' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Yes/No' })).not.toBeChecked();
  });

  it('sizes segments to their labels unless asked to fill the row', () => {
    // `flex-1` makes every segment as wide as the narrowest, which truncates the longest
    // label even with room to spare. It belongs to the fill-the-row mode only.
    const { rerender } = render(
      <SegmentedControl
        options={OPTIONS}
        value="optimal"
        onValueChange={() => {}}
        ariaLabel="Answer style"
      />,
    );
    expect(screen.getByRole('radio', { name: 'Details' }).className).not.toContain('flex-1');

    rerender(
      <SegmentedControl
        options={OPTIONS}
        value="optimal"
        onValueChange={() => {}}
        ariaLabel="Answer style"
        full
      />,
    );
    expect(screen.getByRole('radio', { name: 'Details' }).className).toContain('flex-1');
  });

  it('reports the new value when another mode is chosen', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={OPTIONS}
        value="optimal"
        onValueChange={onChange}
        ariaLabel="Answer style"
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Details' }));
    expect(onChange).toHaveBeenCalledWith('details');
  });

  it('moves between modes with the arrow keys', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={OPTIONS}
        value="optimal"
        onValueChange={onChange}
        ariaLabel="Answer style"
      />,
    );
    screen.getByRole('radio', { name: 'Optimal' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('details');

    onChange.mockClear();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('yes_no');
  });

  it('wraps around at both ends', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={OPTIONS}
        value="details"
        onValueChange={onChange}
        ariaLabel="Answer style"
      />,
    );
    screen.getByRole('radio', { name: 'Details' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('yes_no');
  });

  it('is a single tab stop, with the group taking focus and delegating to its options', () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="optimal"
        onValueChange={() => {}}
        ariaLabel="Answer style"
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Answer style' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('tabindex', '-1');
    }
  });
});

describe('Select', () => {
  const OPTIONS = [
    { value: 'uae-fire', label: 'UAE Fire and Life Safety Code' },
    { value: 'nfpa-101', label: 'NFPA 101' },
  ];

  it('shows the selected source and reports a change', async () => {
    const onChange = vi.fn();
    render(
      <Select
        options={OPTIONS}
        value="uae-fire"
        onValueChange={onChange}
        ariaLabel="Knowledge source"
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Knowledge source' });
    expect(trigger).toHaveTextContent('UAE Fire and Life Safety Code');

    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: 'NFPA 101' }));
    expect(onChange).toHaveBeenCalledWith('nfpa-101');
  });

  it('shows the placeholder when nothing is selected', () => {
    render(
      <Select
        options={OPTIONS}
        value=""
        onValueChange={() => {}}
        ariaLabel="Knowledge source"
        placeholder="All sources"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Knowledge source' })).toHaveTextContent(
      'All sources',
    );
  });
});

describe('Checkbox and SwitchField', () => {
  it('toggles a source on and off', async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox checked={false} onCheckedChange={onCheckedChange} label="UAE Fire Code" />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'UAE Fire Code' }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle when disabled', async () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox checked={false} onCheckedChange={onCheckedChange} label="Locked source" disabled />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Locked source' }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('describes what a switch does, not just its state', async () => {
    const onCheckedChange = vi.fn();
    render(
      <SwitchField
        label="Allow general knowledge fallback"
        description="Answers outside your sources are labelled as unverified."
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    const toggle = screen.getByRole('switch', { name: /Allow general knowledge fallback/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/labelled as unverified/)).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});

describe('state components', () => {
  it('announces a loading region to screen readers', () => {
    render(
      <LoadingRegion label="Loading sources">
        <div>skeleton</div>
      </LoadingRegion>,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // The live region announces its content, so the label must be inside it.
    expect(region).toHaveTextContent('Loading sources');
  });

  it('offers a way forward from an empty state', async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No knowledge sources yet"
        description="Upload a document to begin."
        action={<Button onClick={onClick}>Upload document</Button>}
      />,
    );
    expect(screen.getByText('No knowledge sources yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Upload document' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('makes an error recoverable and traceable', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="Could not load sources"
        message="The request timed out."
        traceId="01JQ8Z9CT2K"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The request timed out.');
    expect(screen.getByText(/01JQ8Z9CT2K/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('reports a stalled refresh politely, and does not pose as a failure', async () => {
    const onRetry = vi.fn();
    render(<StaleNotice message="Too many requests. Please slow down." onRetry={onRetry} />);

    // status, not alert: the content it sits above is still there and still correct, so
    // this must not interrupt a screen reader mid-sentence the way a failure would.
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Live updates paused');
    expect(notice).toHaveTextContent('Too many requests. Please slow down.');
    expect(screen.queryByRole('alert')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /retry now/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('exposes upload progress numerically, not only as a bar', () => {
    render(<ProgressBar value={42} label="Extracting text" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAccessibleName('Extracting text');
  });

  it('clamps an out-of-range progress value instead of overflowing the track', () => {
    render(<ProgressBar value={150} label="Indexing" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('Badge', () => {
  it('renders a verification state as text, so it is not colour-only', () => {
    render(<Badge tone="success">Verified</Badge>);
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });
});
