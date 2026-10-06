export default function BlogPost({ params }: { params: { slug: string } }) {
  return <div>Post {params.slug}</div>;
}
