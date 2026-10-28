import { Link } from 'react-router';
import { PageHeader } from '../components';

/** Shown for any unknown path inside the console. */
export default function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <p>There is no page at this address. It may have moved, or the link may be mistyped.</p>
      <p>
        <Link to="/alerts">Go to the alert queue</Link>
      </p>
    </>
  );
}
