"use server";

export async function createUser(formData: FormData) {
  return { name: formData.get("name") };
}

export async function deleteUser(id: string) {
  return { deleted: id };
}
