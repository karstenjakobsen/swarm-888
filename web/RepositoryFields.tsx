import { useEffect, useState } from 'react';
import { api } from './api';
import type { RepositoryRecord } from '../src/packages/schemas';
import { managementError } from './management';

export function RepositoryFields({ repositoryId, packagePath, onChange, onError, disabled = false, prefix = 'source' }: {
  repositoryId: string;
  packagePath: string;
  onChange: (value: { repositoryId: string; packagePath: string }) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  prefix?: string;
}) {
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    void api<RepositoryRecord[]>('/repositories').then(value => { if (alive) setRepositories(value); }).catch(cause => { if (alive) onError(managementError(cause)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const ready = repositories.filter(repository => repository.status === 'ready');
  return <div className="repository-fields"><label htmlFor={`${prefix}-repository`}>Git repository</label><select id={`${prefix}-repository`} value={repositoryId} disabled={disabled || loading} onChange={event => onChange({ repositoryId: event.target.value, packagePath })} required><option value="">{loading ? 'Loading repositories…' : 'Choose a registered repository'}</option>{ready.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}</select>{!loading && !ready.length && <p className="management-warning">{repositories.length ? 'No registered repository is ready. Open Repositories to check its status.' : 'Add a repository in Repositories first. Every package needs a remote URL and a Git checkout.'}</p>}<label htmlFor={`${prefix}-package-path`}>Folder in repository</label><input id={`${prefix}-package-path`} value={packagePath} disabled={disabled} onChange={event => onChange({ repositoryId, packagePath: event.target.value })} placeholder="apps/my-project" required /><p className="small-note">Use a relative folder, or <code>.</code> for the repository root. Existing packages can be imported from Repositories.</p></div>;
}
