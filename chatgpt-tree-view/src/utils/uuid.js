export const generateUserMessageUUID = () => {
    const uuid = crypto.randomUUID()
    return 'aaa' + uuid.slice(3)
}