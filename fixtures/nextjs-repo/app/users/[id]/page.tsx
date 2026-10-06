export default function UserPage({ params }: { params: { id: string } }) {
  return <div>User {params.id}</div>;
}
