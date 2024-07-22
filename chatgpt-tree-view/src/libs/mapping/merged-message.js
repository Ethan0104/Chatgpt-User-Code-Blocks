import React from 'react'

import { ContentPart } from './util-models'
import { MessageBlock } from '../elements/message-block'
import { logError } from '../utils'

export class MergedMessage {
    // the class that represents a supernode in the tree:
    // it is a collection of 1 user message and (potentially) multiple multipart assistant messages
    constructor(rawUserMessage, parent) {
        this.id = rawUserMessage.id
        this.parent = parent
        
        // load the user message first, the user message is like the root within the tree in this supernode
        try {
            this.userMessageChunks = this.loadUserMessage(rawUserMessage)
        } catch (error) {
            logError("Failed to load User Message: ", error)
        }

        // explore the paths that stem from the user message (this will have more than one path iff "regenerate" is used)
        try {
            const childrenIds = rawUserMessage.childrenIds
            const leafMessages = []
            this.assistantBranches = childrenIds.map((childId) => {
                const rawMessages = this.validateAndExtractLinkedList(rawUserMessage, childId)

                // note down the leaf message of this branch while we are at it
                const lastRawMessage = rawMessages[rawMessages.length - 1]
                leafMessages.push(lastRawMessage)

                return this.buildSingleAssistantMessage(rawMessages)
            })

            // aggregate the children of the leaf messages
            this.children = []
            leafMessages.forEach((leafMessage) => { // leafMessage is a RawMessage object
                const leafChildrenIds = leafMessage.childrenIds
                const leafChildren = leafChildrenIds.map((childId) => {
                    return leafMessage.children[childId]
                })
                
                leafChildren.forEach((leafChild) => {
                    if (!leafChild.isUserMessage()) {
                        throw new Error("Assertion Error: Expected leaf children to be user messages")
                    }

                    this.children.push(new MergedMessage(leafChild, this))
                })
            })
        } catch (error) {
            logError("Failed to load (potentially) multiple multipart Assistant Messages: ", error)
        }
    }

    loadUserMessage(rawUserMessage) {
        const rawParts = rawUserMessage?.content?.parts || []
        const rawAttachments = rawUserMessage?.metadata?.attachments || []
        
        // do a filter for texts only because images will be in the attachments field anyways
        const filteredRawParts = rawParts.filter((part) => typeof part === 'string')
        const contentFieldChunks = filteredRawParts.map((part) => {
            return new ContentPart("text", part)
        })
        const attachmentFieldChunks = rawAttachments.map((attachment) => {
            const type = attachment.mime_type.includes("image") ? "image" : "file"
            return new ContentPart(type, attachment.id, attachment.mime_type)
        })
        return attachmentFieldChunks.concat(contentFieldChunks)
    }

    validateAndExtractLinkedList(rawUserMessage, childId) {
        const rawMessages = []
        let currentChildId = childId
        let currentChild = rawUserMessage.children[currentChildId]
        while (currentChild && !currentChild.isUserMessage()) {
            rawMessages.push(currentChild)
            if (currentChild.childrenIds.length == 0) {
                break
            } else if (currentChild.childrenIds.length != 1) {
                throw new Error("Assertion Error: Expected the assistant response branch to be linear")
            }

            currentChildId = currentChild.childrenIds[0]
            currentChild = currentChild.children[currentChildId]
        }
        return rawMessages
    }

    buildSingleAssistantMessage(rawMessages) {
        const chunks = []
        rawMessages.forEach((rawMessage) => {
            const contentType = rawMessage.content.content_type
            if (contentType === "text" || contentType === "multimodal_text") {
                const parts = rawMessage.content.parts
                parts.forEach((part) => {
                    if (typeof part === 'string') {
                        chunks.push(new ContentPart("text", part))
                    } else if (typeof part === 'object') {
                        chunks.push(new ContentPart("image", part.asset_pointer.replace("file-service://", "")))
                    }
                })
            } else if (contentType === "execution_output") {
                chunks.push(new ContentPart("code", [rawMessage.metadata?.aggregate_result?.code || "", rawMessage.content.text]))
            } else {
                throw new Error(`Unexpected content type when building assistant message chunks: ${contentType}`)
            }
        })
        return chunks
    }

    findMessageById(id) {
        if (this.id === id) {
            return this
        }

        for (let i = 0; i < this.children.length; i++) {
            const child = this.children[i]
            const result = child.findMessageById(id)
            if (result) {
                return result
            }
        }
        return null
    }

    deleteChildMessageById(id, recurse) {
        if (this.childrenIds.includes(id)) { // Base case
            // if the child to delete has children, its children should be bumped up to this level
            const child = this.children[id]
            if (child.childrenIds.length > 0) {
                child.childrenIds.forEach((childId) => {
                    this.childrenIds.push(childId)
                    this.children[childId] = child.children[childId]
                })
            }

            // finally, delete this child
            this.childrenIds = this.childrenIds.filter((childId) => childId !== id)
            delete this.children[id]
        } else if (recurse) { // Recursive case
            this.childrenIds.forEach((childId) => {
                this.children[childId].deleteChildMessageById(id, true)
            })
        }
    }

    traverseAndFlagMessagesToRemove(idsToRemove) {
        this.childrenIds.forEach((childId) => {
            const child = this.children[childId]
            if (child.isMessageHidden()) {
                idsToRemove.push(child.id)
            }

            child.traverseAndFlagMessagesToRemove(idsToRemove)
        })
    }

    beginAssistantMessageMerging() {
        if (this.author.role === "user") {

        }
    }

    mergeSubsequentAssistantMessages() {
        if (this.author.role === "tool" && this.author.name === "dalle.text2im") {
            // Perform Dall-E Merging
            if (this.childrenIds.length != 1) {
                throw new Error("Assertion Error: Expected the dalle message only has one child")
            }

            const childId = this.childrenIds[0]
            const assistantMessage = this.children[childId]
            if (assistantMessage.author.role !== "assistant") {
                throw new Error("Assertion Error: Expected the child of the Dall-E message to be an Assistant message")
            }

            // do the merge
            this.content.parts.push(...assistantMessage.content.parts)
            this.author = assistantMessage.author
            this.meta = assistantMessage.meta
            this.deleteChildMessageById(childId, false)
        } else if (this.author.role === "assistant" && this.recipient === "python") {
            // Perform Code Block Merging
            if (this.childrenIds.length != 1) {
                throw new Error("Assertion Error: Expected the child of the code block message to only have one child")
            }

            
        } else {
            throw new Error("Assertion Error: Unexpected entry message for Assistant Message Merging")
        }
    }

    initElement() {
        this.element = <MessageBlock message={this} />
    }

    renderElementRecurse() {
        if (this.parent) { // only render if not root
            this.initElement()
        }

        this.childrenIds.forEach((childId) => {
            this.children[childId].renderElementRecurse()
        })
    }

    printPreOrder() {
        console.log(`${this.id}\n${JSON.stringify(this.userMessageChunks, null, 2)}\n${JSON.stringify(this.assistantBranches, null, 2)}`)
        this.children.forEach((child) => {
            child.printPreOrder()
        })
    }
}
