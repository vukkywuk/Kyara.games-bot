import { Link } from 'react-router';
import { EmptyState } from '../components/ui';
import { Compass } from 'lucide-react';

export function NotFound() {
  return (
    <EmptyState icon={Compass} title="This page does not exist" action={<Link className="text-focus underline underline-offset-4" to="/">Go to the dashboard</Link>}>
      Check the address, or use the navigation on the left.
    </EmptyState>
  );
}
